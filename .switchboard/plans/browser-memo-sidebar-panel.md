# Add a Memo Panel to Browser/Headless Mode's Left Sidebar

## Goal

Add **Memo** as its own view in the left icon strip of the headless **browser mode** (the `shell.html` app-shell), reached like Board / Project / Artifacts / Design / Setup. Remove the memo UI from `project.html` entirely — memo does not belong as a Project tab.

### Problem & root cause

The headless browser UI (`src/services/LocalApiServer.ts` + `src/webview/shell.html`) renders its left icon strip from a **data-driven panels manifest** (`headlessPanelHtml.ts` → `getPanelsManifest()`), mounting each panel as a same-origin iframe. That manifest today is only: `board`, `project`, `planning` (Artifacts), `design`, `setup` — there is **no Memo panel**.

Because there was no Memo panel, memo got stuffed into `project.html` as a tab (`project.html:1232`, button `data-tab="memo"`; content block from `project.html:1473`). That is the wrong home — memo is not a Project concern.

The memo backend already works headlessly: the memo UI posts `memoLoad` / `memoSave` / `memoClear` / `memoGeneratePrompt`, `transport.js` turns those into `POST /<panel>/verb/<verb>`, and `LocalApiServer` routes memo verbs to `_handlePlanningVerb` (`LocalApiServer.ts:3291–3293`). Memo state is just the file `.switchboard/memo.md`. So this is a **UI + routing relocation, not new backend logic.**

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, refactor

## Non-Goals

- No deep-links, no `switchboard.openMemo` wiring, no cross-panel "open memo" navigation, nothing that touches VS Code commands. (This was the mistake in the prior draft — explicitly excluded.)
- No change to `implementation.html` or `TaskViewerProvider`.
- No change to memo persistence, memo verbs, or `.switchboard/memo.md` semantics.

## Implementation Plan

### 1. New Memo panel — `src/webview/memo.html` + `src/webview/memo.js`

- **`memo.html`**: a standalone panel using the same `{{...}}` token conventions as the other headless panels (`design.html` / `project.html` shape). Lift the memo markup out of `project.html`'s `#memo-content` block (`project.html:1473`): intro/tip text, `#memo-textarea`, `#memo-status`, and the `#memo-clear-btn` / `#memo-copy-btn` / `#memo-send-btn` buttons (drop the `shared-tab-content` wrapper; render directly as a centered column). Include the standard font `@font-face`, theme tokens, and same-origin CSP `<meta>` copied from the other panels' headers. Carry over the `host-terminal-dispatch-false #memo-send-btn` hide rule so "Send to Planner" hides when the host has no terminal dispatch. Include `transport.js` then `memo.js` (transport first, so the `window.vscode` shim exists before `memo.js` runs). The `<body>` is authored so the renderer can inject its `data-*` attributes.
- **`memo.js`**: extract the memo logic currently in `project.js` — on load post `memoLoad` (workspace root from `document.body.dataset.initialWorkspaceRoot`); debounced `memoSave` on input; `memoClear` on Clear; `memoGeneratePrompt` (`action:'copy'`) on Copy Prompt; `memoGeneratePrompt` (send-to-planner) on Send to Planner; handle inbound `memoContent` / `memoPromptResult` / `memoError` exactly as `project.js:1175–1195` does. Reuse the existing `_memoDirty` / `_memoSaveTimer` debounce/dirty logic verbatim.

Body carries `data-panel="memo"`, so `transport.js` (`transport.js:25–26`) posts to `POST /memo/verb/<verb>` (wired in step 3).

### 2. Renderer — `src/services/headlessPanelHtml.ts`

- Add `getMemoHtml(repoRoot, workspaceRoot, capabilities?, themeClass?)` following the `getPlanningHtml` / `getDesignHtml` template: read `dist/webview/memo.html` then `src/webview/memo.html`, replace `{{MEMO_JS_URI}}` (→ `/static/webview/memo.js`), `{{HANKEN_FONT_URI}}`, `{{GEIST_PIXEL_FONT_URI}}`; set body attributes `data-panel="memo"`, `data-initial-workspace-root`, `data-host-capabilities`; apply the theme class; return `{ html, csp }` with the same same-origin CSP as the other panels.
- Add `case 'memo': return getMemoHtml(...)` to `getPanelHtmlById` (`headlessPanelHtml.ts:322–331`).
- Add a manifest entry in `getPanelsManifest()` (`headlessPanelHtml.ts:313–319`): `{ id: 'memo', label: 'Memo', icon: `${iconDir}/<chosen-icon>.png`, route: '/memo', enabled: true }`. Place it after `project`. Pick a distinct icon from `/static/icons` not already used by another strip entry (e.g. a note/pencil Sci-Fi Flat icon).

### 3. Routing — `src/services/LocalApiServer.ts`

- Serve the panel: add alongside the other panel routes (`LocalApiServer.ts:3383–3388`):
  `else if ((pathname === '/memo' || pathname === '/memo.html') && req.method === 'GET') { await this._handleServePanelById('memo', req, res); }`.
- Serve the verbs: add alongside `/project/verb/` (`LocalApiServer.ts:3291–3293`):
  `else if (pathname.startsWith('/memo/verb/') && req.method === 'POST') { const verb = …; await this._handlePlanningVerb(verb, req, res); }`.
  Reusing `_handlePlanningVerb` is deliberate — it is the exact handler the current memo UI already uses, so behavior is identical.

### 4. Remove memo from `project.html` / `project.js`

- **`project.html`**: remove the `data-tab="memo"` tab button (`project.html:1232`) and the entire `#memo-content` block (`project.html:1473`). Remove any memo-only CSS that becomes dead.
- **`project.js`**: remove the `activeTab === 'memo'` load branch (`project.js:52–53`), the `memoContent` / `memoPromptResult` / `memoError` message cases (`project.js:1175–1195`), and the memo element wiring/debounce block (`project.js:1211` onward). Leave no dangling `#memo-*` references.

## Files Touched

- **New:** `src/webview/memo.html`, `src/webview/memo.js`
- `src/services/headlessPanelHtml.ts` — `getMemoHtml`, `getPanelHtmlById` case, manifest entry
- `src/services/LocalApiServer.ts` — `/memo` serve route + `/memo/verb/` verb route
- `src/webview/project.html` — remove memo tab button + content block
- `src/webview/project.js` — remove memo load branch, message cases, element wiring

## Verification Plan

Testing is via an installed VSIX; treat `src/` as source of truth.

1. **Panel present:** launch the headless server, open the shell — the left strip shows a new **Memo** icon (with hover label) after Project. `GET /panels` includes the `memo` entry; `GET /memo` returns 200.
2. **Memo works:** open Memo — existing `.switchboard/memo.md` loads into the textarea; typing debounce-saves (reload confirms persistence); **Clear** empties it; **Copy Prompt** / **Send to Planner** behave as before (status line updates). Confirm requests hit `POST /memo/verb/<verb>` and succeed.
3. **Project cleaned up:** the Project panel no longer has a MEMO tab; remaining tabs switch with no console errors and no dangling `#memo-*` references.
4. **Theming/CSP:** Memo renders correctly under the active theme (incl. `theme-claudify`) with no CSP errors.
5. **State isolation:** `data-panel="memo"` uses its own `sb-state-memo` localStorage key (no collision with `sb-state-project`).
