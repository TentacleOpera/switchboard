# Promote Memo to a First-Class Left-Sidebar Panel in Browser/Headless Mode

## Goal

Give the headless **browser mode** (`shell.html` app-shell) a dedicated **Memo** view in the left icon strip — its own route/panel, mounted like Board/Project/Artifacts/Design/Setup — and remove the memo UI that was awkwardly wedged into the Project panel (`project.html`). After this change, in browser mode Memo is reached from the left sidebar strip, not buried as a tab inside Project.

### Problem & background (root-cause analysis)

The extension has two independent front-ends:

- **VS Code webviews** — the activity-bar sidebar view is `src/webview/implementation.html` (backed by `TaskViewerProvider`). Its sub-tab bar is **Agents / Terminals / Memo** (`implementation.html:1570–1607`). This is where memo lives *normally*; `switchboard.openMemo` → `TaskViewerProvider.openMemoTab()` reveals it.
- **Headless browser mode** — `src/services/LocalApiServer.ts` serves a self-contained web UI. `src/webview/shell.html` renders a left icon strip **data-driven from a panels manifest** (`headlessPanelHtml.ts` → `getPanelsManifest()`), and mounts each panel as a same-origin iframe. The manifest today is exactly: `board`, `project`, `planning` (Artifacts), `design`, `setup`.

**Root cause:** `implementation.html` — the sidebar that owns Memo in VS Code — has **no headless implementation**. It is never rendered by `headlessPanelHtml.ts` and has no manifest entry or route. So when Memo was wanted in browser mode (commit `89d02d8`, 2026-07-21, "Relocate Kanban Search… + Add Features Tab Search"), instead of porting a proper view it was added as a **tab inside `project.html`** (`project.html:1232` button `data-tab="memo"`; content block from `project.html:1473`). That is the "bizarre" placement: Memo is conceptually a sidebar/implementation surface, but in browser mode it appears as a Project sub-tab.

The memo backend already works headlessly: `project.js` posts `memoLoad` / `memoSave` / `memoClear` / `memoGeneratePrompt`, and `transport.js` turns those into `POST /project/verb/<verb>`, which `LocalApiServer` routes to `_handlePlanningVerb` (`LocalApiServer.ts:3291–3293`). Memo state is just the file `.switchboard/memo.md`. So the fix is a **UI/routing relocation**, not new backend logic.

### Chosen shape (decided with the user)

1. **Memo-only** browser panel — a new `/memo` route with its own strip icon. (Not a full `implementation.html` port; Agents/Terminals lean on VS Code terminal APIs and are out of scope.)
2. **Remove** the memo tab from `project.html` so Memo lives in exactly one place.

### Explicit consequence to confirm during review

`project.html` is the **Project panel in BOTH VS Code and browser mode** (`PlanningPanelProvider`). Removing the memo tab from it therefore also removes the memo tab from the **VS Code Project panel**. This is acceptable and de-duplicating: in VS Code, Memo remains available in its canonical home, the `implementation.html` sidebar (Agents/Terminals/**Memo**) and via `switchboard.openMemo`. This plan does **not** touch `implementation.html` or `TaskViewerProvider`.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, refactor

## Non-Goals

- No port of Agents/Terminals to browser mode.
- No change to `implementation.html`, `TaskViewerProvider`, or the VS Code sidebar memo sub-tab.
- No change to memo persistence, memo verbs, or `.switchboard/memo.md` semantics.
- No migration concern: the browser-mode memo-in-project-tab surface is recent (2026-07-21) and unreleased-as-a-standalone-view; the underlying `.switchboard/memo.md` file and its verbs are untouched, so no user data is affected.

## Implementation Plan

### 1. New standalone Memo panel HTML — `src/webview/memo.html`

Create a minimal standalone panel modeled on the other headless panels' token conventions (`design.html` / `project.html` shape — a `{{...}}` token set and a single `{{MEMO_JS_URI}}`-style script include). Contents:

- `<body ...>` will receive its `data-*` attributes via the renderer (see step 3) — author the file with a body the renderer can rewrite, matching how `getProjectHtml`/`getDesignHtml` inject `data-panel`, `data-initial-workspace-root`, and `data-host-capabilities`.
- Lift the **memo tab markup** currently in `project.html` (the `#memo-content` block starting `project.html:1473`: the intro/tip text, `#memo-textarea`, `#memo-status`, and the `#memo-clear-btn` / `#memo-copy-btn` / `#memo-send-btn` buttons). Drop the outer `shared-tab-content` wrapper; render the memo body directly (centered column, same inline layout as today).
- Include the standard font `@font-face` + theme tokens and CSP `<meta>` consistent with the other panels (copy the pattern from `project.html`/`design.html` headers). Carry over the `host-terminal-dispatch-false #memo-send-btn` visibility rule from `transport.js` so "Send to Planner" hides when the host lacks terminal dispatch.
- Reference a new script `src/webview/memo.js` (see step 2) plus `transport.js` (same include order the other headless panels use, so `window.vscode` shim is installed before `memo.js` runs).

### 2. Memo panel script — `src/webview/memo.js`

Extract the memo logic from `project.js` into a self-contained script:

- On load, post `{ type: 'memoLoad', workspaceRoot }` (workspace root read from `document.body.dataset.initialWorkspaceRoot`, matching how other panels resolve it).
- Wire the same handlers currently in `project.js`: debounced `memoSave` on textarea input, `memoClear` on Clear, `memoGeneratePrompt` with `action:'copy'` on Copy Prompt, and `memoGeneratePrompt` with the "send to planner" action on Send to Planner.
- Handle inbound `memoContent` / `memoPromptResult` / `memoError` messages exactly as `project.js:1175–1195` does (update textarea unless focused/dirty; update `#memo-status`).
- Reuse the existing dirty-tracking/debounce logic (`_memoDirty`, `_memoSaveTimer`) verbatim.

Because the panel body will carry `data-panel="memo"`, `transport.js` (`transport.js:25–26`) will post these to `POST /memo/verb/<verb>` — wired in step 4.

### 3. Renderer — `src/services/headlessPanelHtml.ts`

- Add `getMemoHtml(repoRoot, workspaceRoot, capabilities?, themeClass?)`, following the `getPlanningHtml` / `getDesignHtml` template: read `dist/webview/memo.html` then `src/webview/memo.html` (source-of-truth is `src/`), replace the `{{MEMO_JS_URI}}` (→ `/static/webview/memo.js`), `{{HANKEN_FONT_URI}}`, `{{GEIST_PIXEL_FONT_URI}}` tokens, set the body attributes with `data-panel="memo"`, `data-initial-workspace-root`, `data-host-capabilities`, apply the theme class, and return `{ html, csp }` with the same same-origin CSP the other panels use.
- Add `case 'memo': return getMemoHtml(...)` to `getPanelHtmlById` (`headlessPanelHtml.ts:322–331`).
- Add a manifest entry in `getPanelsManifest()` (`headlessPanelHtml.ts:313–319`):
  `{ id: 'memo', label: 'Memo', icon: `${iconDir}/<chosen-icon>.png`, route: '/memo', enabled: true }`.
  Position it after `project` (Memo is a capture surface adjacent to Project) or immediately before `setup` — pick per visual review. Choose a distinct icon from `/static/icons` not already used by another strip entry (e.g. a note/pencil Sci-Fi Flat icon); do not reuse the Artifacts/Design icon.

### 4. Routing — `src/services/LocalApiServer.ts`

- **Serve the panel:** add a branch alongside the other panel routes (`LocalApiServer.ts:3383–3388`):
  `else if ((pathname === '/memo' || pathname === '/memo.html') && req.method === 'GET') { await this._handleServePanelById('memo', req, res); }`.
  `_handleServePanelById` already dispatches to `serveStatic.getPanelHtml(id)` → `getPanelHtmlById('memo', …)`, so no other serve wiring is needed.
- **Serve the verbs:** add a branch alongside `/project/verb/` (`LocalApiServer.ts:3291–3293`):
  `else if (pathname.startsWith('/memo/verb/') && req.method === 'POST') { const verb = …; await this._handlePlanningVerb(verb, req, res); }`.
  Reusing `_handlePlanningVerb` is deliberate — it is the exact handler the working project-tab memo already uses, so `memoLoad/memoSave/memoClear/memoGeneratePrompt` behave identically.

### 5. Remove memo from the Project panel

- **`src/webview/project.html`:** remove the `data-tab="memo"` tab button (`project.html:1232`) and the entire `#memo-content` `shared-tab-content` block (from `project.html:1473`). Remove any memo-only CSS that becomes dead.
- **`src/webview/project.js`:** remove the `activeTab === 'memo'` load branch (`project.js:52–53`), the `memoContent`/`memoPromptResult`/`memoError` message cases (`project.js:1175–1195`), and the memo element wiring/debounce block (`project.js:1211` onward through the memo button listeners). Ensure no dangling references to removed `#memo-*` element IDs remain (guard-check the file compiles/lints clean).
- Leave `_handlePlanningVerb`'s memo verb handling intact — it now backs `/memo/verb/` instead of `/project/verb/`.

### 6. Nice-to-have (optional, do only if low-cost)

- The shell already supports `/#<panelId>` deep-links and the `switchPanel` postMessage bridge (`shell.js:9–11`), so `/#memo` will select the new panel automatically once it's in the manifest — verify, no code needed.
- If any browser-mode surface emits an `openMemo`-style message, map it in `transport.js`'s `PANEL_SWITCH_VERBS` to `{ switchPanel: 'memo' }` so "open memo" affordances cross-navigate. Skip if no such caller exists in headless mode.

## Files Touched

- **New:** `src/webview/memo.html`, `src/webview/memo.js`
- `src/services/headlessPanelHtml.ts` — `getMemoHtml`, `getPanelHtmlById` case, `getPanelsManifest` entry
- `src/services/LocalApiServer.ts` — `/memo` serve route + `/memo/verb/` verb route
- `src/webview/project.html` — remove memo tab button + content block
- `src/webview/project.js` — remove memo load branch, message cases, and element wiring

## Verification Plan

Testing is via an installed VSIX (not `dist/`); treat `src/` as source of truth.

1. **Browser mode — panel present:** launch the headless server, open the shell. The left icon strip shows a new **Memo** icon (with hover label) after/around Project. `GET /panels` includes the `memo` entry; `GET /memo` returns the panel HTML (200).
2. **Browser mode — memo works:** open Memo. Existing `.switchboard/memo.md` content loads into the textarea (`memoLoad` → `memoContent`). Type → debounced save writes the file (`memoSave`); reload the panel and confirm persistence. **Clear** empties it; **Copy Prompt** and **Send to Planner** behave as before (status line updates via `memoPromptResult`/`memoError`). Confirm requests hit `POST /memo/verb/<verb>` (network tab / server logs) and succeed.
3. **Browser mode — Project cleaned up:** the Project panel no longer shows a MEMO tab; the remaining tabs (KANBAN PLANS / FEATURES / PRDS / CONSTITUTION / SYSTEM / TUNING) switch without console errors, and no dangling `#memo-*` references throw.
4. **VS Code parity intact:** in the actual extension, the sidebar `implementation.html` view still shows **Agents / Terminals / Memo**, and `switchboard.openMemo` still reveals the memo sub-tab. The VS Code **Project** panel no longer shows a duplicate MEMO tab (expected consequence).
5. **Theming/CSP:** the Memo panel renders correctly under the active theme (including `theme-claudify`) and violates no CSP (same-origin script via nonce, WS to 127.0.0.1) — check the console for CSP errors.
6. **State isolation:** with `data-panel="memo"`, the panel's `sb-state-memo` localStorage key does not collide with `sb-state-project`.

## Risks & Mitigations

- **Shared `project.js`/`project.html` edits affect VS Code too.** Mitigation: memo is fully removed from the Project panel in both hosts by design (decided); VS Code retains memo in `implementation.html`. Verify step 4.
- **Verb rail mismatch.** If a `data-panel="memo"` panel posted to a non-existent `/memo/verb/`, memo would silently no-op. Mitigation: step 4 adds the route to the proven `_handlePlanningVerb`; verify in step 2 via network/logs.
- **Icon collision.** Reusing an existing strip icon would confuse the strip. Mitigation: pick an unused icon (step 3).
