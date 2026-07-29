# Add a Memo Panel to Browser/Headless Mode's Left Sidebar

## Goal

Add **Memo** as its own view in the left icon strip of the headless **browser mode** (the `shell.html` app-shell), reached like Board / Project / Artifacts / Design / Setup. Remove the memo UI from `project.html` entirely — memo does not belong as a Project tab.

### Problem & root cause

The headless browser UI (`src/services/LocalApiServer.ts` + `src/webview/shell.html`) renders its left icon strip from a **data-driven panels manifest** (`headlessPanelHtml.ts` → `getPanelsManifest()`), mounting each panel as a same-origin iframe. That manifest today is only: `board`, `project`, `planning` (Artifacts), `design`, `setup` — there is **no Memo panel**.

Because there was no Memo panel, memo got stuffed into `project.html` as a tab (`project.html:1232`, button `data-tab="memo"`; content block from `project.html:1473`). That is the wrong home — memo is not a Project concern.

The memo backend already works headlessly: the memo UI posts `memoLoad` / `memoSave` / `memoClear` / `memoGeneratePrompt`, `transport.js` turns those into `POST /<panel>/verb/<verb>`, and `LocalApiServer` routes memo verbs to `_handlePlanningVerb` (`LocalApiServer.ts:3300–3302`). Memo state is just the file `.switchboard/memo.md`. So this is a **UI + routing relocation, not new backend logic.**

### Verified backend facts (established during plan review — do not re-derive)

These were confirmed by reading the code. They are the load-bearing assumptions the implementation rests on:

1. **Both hosts already implement all four memo verbs, by two different paths.**
   - **Extension host:** `PlanningPanelProvider.handleServiceVerb` (`PlanningPanelProvider.ts:106–111`) special-cases the four memo verbs *before* the `PLANNING_VERBS` allowlist guard and delegates to `TaskViewerProvider.handleServiceVerb`, where the arms live (`TaskViewerProvider.ts:11967–12060`). The verbs are in `TASKVIEWER_VERBS`, **not** `PLANNING_VERBS` — the delegation is what makes them reachable on the planning rail at all.
   - **Standalone host:** `src/standalone/bootstrap.ts:870–973` implements the four verbs inline in its `planningVerb` router, *ahead of* delegation to `PlanningPanelProvider`, with a deliberate headless degrade (`action:'send'` → copy, prompt returned in the body for `transport.js` to write to the clipboard).
   - **Consequence:** routing `/memo/verb/` at `_handlePlanningVerb` is not merely "the handler the current UI uses" — it is the **only** prefix that preserves the standalone send→copy degrade. See the Superseded callout in Proposed Changes → `LocalApiServer.ts`.

2. **Hydration arrives by different mechanisms per host, and both already work.**
   - Extension host: the arms return `{success:true, content}` with **no `type` field**, so `transport.js`'s body re-dispatch matches no `case`. The panel hydrates instead from the WS push — `TaskViewerProvider.postMessage` → `BroadcastHub.push` → `broadcastWs('memoContent', …)` (`broadcastHub.ts:69–79`), which reaches every connected client including the memo iframe.
   - Standalone host: the handlers return `{success:true, type:'memoContent', content}`, so hydration comes from the HTTP body re-dispatch in `transport.js:259–261`. No WS push.
   - **Do not "fix" the missing `type` on the TaskViewer arms as part of this plan.** It is not the mechanism in use there, and adding it would make the extension host deliver `memoContent` twice (body + WS).

3. **No allowlist, catalog, or gate change is required.** `scripts/generate-verb-allowlist.js` and `check-protocol-parity.js` are keyed to the five *providers* (Kanban/Planning/Design/TaskViewer/Setup), not to HTTP route prefixes. `/memo/verb/` is a new prefix on an existing provider rail, so `parity:check`, `verb-returns:check`, and `push-routing:check` are all unaffected. There is no `MEMO_VERBS` set to generate.

4. **No webpack change is required.** `webpack.config.js:77–88` copies `src/webview/*.html` and `src/webview/*.js` by glob, so `memo.html` / `memo.js` land in `dist/webview/` automatically — which matters because the VSIX ships only `dist/`.

5. **No persisted-tab migration is required.** `project.js:7` hard-initialises `activeTab = 'kanban'` and the Project panel restores no persisted tab (`persistTabState` is used by `planning.html` / `design.html`, not `project.html`). Removing the MEMO tab cannot strand a user on a tab that no longer exists.

6. **`switchboard.openMemo`, the status-bar item, and the memo hotkey are unaffected.** All three target the **sidebar** sub-tab, not the Project panel: `extension.ts:1110` → `TaskViewerProvider.openMemoTab()` → `postMessage({type:'openMemoTab'})` → `implementation.html:1574`. Removing project.html's tab breaks none of them.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, refactor

> **Superseded:** **Complexity:** 4
> **Reason:** The review surfaced surface area the 4 did not price in: a self-contained panel document must reproduce the CSP meta, nonce substitution, font `@font-face`, theme-token `:root` block, `.strip-btn`/`.markdown-editor` rules, *and* a `switchboardThemeChanged` handler that every other panel has and this one would silently lack. That is seven touch points across two hosts plus a product-visible removal from the editor's Project panel — "multi-file changes, moderate logic" (5), not "routine single-file" (4).
> **Replaced with:** **Complexity:** 5 → route to **Coder**.

## Non-Goals

- No deep-links, no `switchboard.openMemo` wiring, no cross-panel "open memo" navigation, nothing that touches VS Code commands. (This was the mistake in the prior draft — explicitly excluded.)
- No change to `implementation.html` or `TaskViewerProvider`.
- No change to memo persistence, memo verbs, or `.switchboard/memo.md` semantics.
- No shared-panel-shell / HTML-partial extraction (see Complexity Audit → rejected alternatives). Each panel stays a self-contained document, matching the existing five.

## User Review Required

One accepted product consequence, stated so it is a decision rather than a discovery:

- **Editor users lose the MEMO tab from the Project panel, and `memo.html` does not replace it there.** `memo.html` is reachable only from the headless shell's icon strip; no `switchboard.*` command opens it as a VS Code webview panel. In the editor, memo survives **only** via `implementation.html`'s sidebar Memo sub-tab — which is its documented home (`AGENTS.md`: "The Memo sub-tab in the sidebar remains as an alternative processing path") and the target of `switchboard.openMemo`, the status-bar button, and the hotkey. This plan treats the sidebar as the editor's memo home and the new panel as the browser's. **Decision: accepted as specified** — the Goal says memo does not belong as a Project tab, and the sidebar path is unbroken. Nothing to resolve; noted for visibility only.

## Complexity Audit

### Routine

- Adding a `getPanelsManifest()` row and a `getPanelHtmlById` case — both hosts read the same shared functions (`TaskViewerProvider.ts:1863/1870`, `bootstrap.ts:425/427`), so one edit covers both.
- Adding two `else if` branches to `LocalApiServer._handleRequest` — direct copies of the adjacent `/project` and `/project/verb/` branches.
- `getMemoHtml()` — a shortened clone of `getPlanningHtml` / `getDesignHtml`.
- Lifting the memo markup and the memo JS block verbatim out of `project.html` / `project.js`.
- Deleting the memo tab button, content block, load branch, message cases, and wiring block from the Project panel.
- Icon + manifest label — cosmetic.
- No webpack, allowlist, catalog, schema, or ratchet-baseline change (verified facts 3 and 4).

### Complex / Risky

- **Reproducing the panel preamble without a shared partial.** `memo.html` must carry its own CSP `<meta>`, `{{NONCE}}`, `@font-face` blocks, theme-token `:root` block, and the `.strip-btn` / `.markdown-editor` rules the lifted markup depends on — none of which exist outside `project.html`'s ~1,200-line inline CSS. Under-doing this yields a panel that answers 200 and works but looks broken.
- **`{{NONCE}}` is a hard blocker if missed.** Every panel CSP is `script-src 'nonce-<n>' 'self'`. A `<script>` in `memo.html` without `nonce="{{NONCE}}"`, or a `getMemoHtml` that forgets the `{{NONCE}}` substitution, means the browser blocks every script and the panel is inert.
- **Live theme sync is easy to omit.** `shell.js:118` posts `{type:'switchboardThemeChanged', theme}` into each iframe on toggle; all five existing panels handle it. `memo.js` must too, or Memo is the one panel that keeps the stale theme after a toggle.
- **`injectTransportShim` fails soft.** With neither the `<!-- SHARED_DEFAULTS_SCRIPT -->` marker nor a matching first-script anchor, it logs and returns the content **unmodified** (`headlessPanelHtml.ts:61–66`) — `acquireVsCodeApi` is then undefined and `memo.js` throws on line 1.
- **Removal must leave no dangling references.** `project.js`'s memo block spans four separate regions (`:52–53`, `:1174–1195`, `:1211–1255`, plus the `getProjectsTabWorkspaceRoot()` call sites); a partial removal leaves `document.getElementById('memo-textarea')` returning null and a `case 'memoContent'` that can never fire.

## Edge-Case & Dependency Audit

### Race Conditions

- **Debounce vs. inbound `memoContent`.** The lifted logic already guards this: `case 'memoContent'` bails when the textarea is focused **or** `_memoDirty` is set (`project.js:1178–1181`), so an 800 ms-pending save is never clobbered by a push. Preserve both halves of that condition verbatim — dropping either reintroduces keystroke loss.
- **Clear vs. in-flight save.** The Clear handler clears `_memoSaveTimer` and resets `_memoDirty` *before* posting `memoClear` (`project.js:1231–1233`). Keep that ordering, or a queued `memoSave` lands after the clear and resurrects the text.
- **Copy/Send vs. in-flight save.** Same pattern at `project.js:1241–1242` and `:1250–1251` — cancel the timer, then post. The backend clears `memo.md` as part of `memoGeneratePrompt`; a late `memoSave` would rewrite it.
- **WS broadcast fan-out is untargeted.** `broadcastWs('memoContent', …)` carries no `surface`, so the push reaches every panel iframe. Harmless — the other panels' switches have no matching case — but it means the memo panel receives `memoContent` even when a *sidebar* action triggered it. That is the desired behaviour (the two views stay in sync); do not add filtering.

### Security

- Panel serving and both verb rails already run `_checkAuth(req, true)` (`LocalApiServer.ts:753`, `:1631`). Reusing `_handleServePanelById` and `_handlePlanningVerb` inherits that unchanged — do not hand-roll a route.
- Schemas for all four memo verbs already exist and are permissive (`verbSchemas.ts:1381–1402`: `workspaceRoot`/`content`/`action`, none required). No schema edit — and per PRD contract #5, tightening them would be a regression on shipped installs.
- `memo.html` is a same-origin panel with a `default-src 'none'` CSP; it loads no remote assets, so the Design/Planning `img-src` loopback widening is **not** needed. Keep the CSP as tight as `getProjectHtml`'s, minus the `frame-src` allowances the memo panel has no use for.
- No secret-write verbs are involved, so no `SECRET_WRITE_VERBS` denial list applies.

### Side Effects

- **`applyThemeClass` rewrites `<body class>` wholesale** (`headlessPanelHtml.ts:71–74` strips the existing `class` attribute). Do not put layout-critical classes on `memo.html`'s `<body>`; put them on an inner wrapper.
- **`sb-state-memo`** becomes a new localStorage key via `transport.js:27`. Nothing reads it (memo keeps no client state), so it stays an empty object — no collision with `sb-state-project`.
- **Workspace targeting changes.** `project.js` sent `getProjectsTabWorkspaceRoot()` — the Project panel's own workspace dropdown, falling back through the kanban filter. `memo.js` has no dropdown and sends `document.body.dataset.initialWorkspaceRoot`. Both hosts resolve this safely: the extension host runs it through `_resolveStateWorkspaceRoot` (`TaskViewerProvider.ts:2343`) which falls back to the selected root, and the standalone host **ignores the payload root entirely** (`const root = workspaceRoot`, bootstrap.ts:934). In a multi-root workspace the panel therefore edits the cockpit's launch/selected root's `memo.md` and does not follow a later Board workspace switch. Accept this — a per-panel workspace selector is out of scope — but do not silently drop the `workspaceRoot` field from the posts; the extension host's arms read it.
- **`#memo-send-btn` gating is automatic.** The `host-terminal-dispatch-false #memo-send-btn { display:none }` rule is injected by `transport.js:324`, not defined in `project.html`. Nothing to carry over.
- **Clipboard.** `Copy Prompt` relies on `navigator.clipboard.writeText` in `transport.js:230–233`; `shell.js:126` already sets `allow="clipboard-read; clipboard-write"` on every panel iframe. `http://127.0.0.1` and `http://localhost` are secure contexts, so this works; a cockpit opened over a LAN IP has no Clipboard API. Pre-existing for every panel's copy action — not introduced here.
- **`shell.js`'s doc comment** lists `/#board, /#project, /#design, /#setup` as the deep-link examples. Deep-linking is generic (`frames.has(hash)`), so `#memo` works with no code change; updating the comment is optional tidying.
- **`PlanningPanelProvider.ts:99–105`'s comment** ("when project.html posts a memo verb") goes stale. Update the comment text; do **not** touch the delegation logic — it is what keeps the verbs reachable.

### Dependencies & Conflicts

- `src/services/headlessPanelHtml.ts` — shared by both hosts; single edit, no fork.
- `src/services/LocalApiServer.ts` — the `else if` chain; the two new branches are order-independent (`pathname === '/memo'` exact vs. `startsWith('/memo/verb/')`).
- `src/webview/project.html` + `project.js` — **one agent stream only** (PRD orchestration discipline: same-file parallel edits collide). These two are the removal half and must land with the addition half; shipping the removal alone is a regression, shipping the addition alone leaves memo in two places.
- No conflict with the in-flight design-panel plans on this branch (`per-client-design-panel-view-state.md`, `fix-stitch-html-tab-loading-and-auto-cache.md`) — disjoint files.

## Dependencies

- None. Every backend dependency (memo verbs, schemas, both hosts' routers, the WS hub) is already shipped and verified present — see "Verified backend facts" above.

## Adversarial Synthesis

**Risk Summary.** The backend is done and the wiring is a five-line copy of existing panel routes; the real risk is entirely in the new document — a `memo.html` that answers 200 and saves correctly while being unstyled (`.strip-btn` / `.markdown-editor` / theme tokens live only in `project.html`'s inline CSS), inert (missing `{{NONCE}}` under a `nonce`-only CSP, or a missing `<!-- SHARED_DEFAULTS_SCRIPT -->` marker so `injectTransportShim` silently no-ops), or theme-frozen (no `switchboardThemeChanged` handler, which all five existing panels have). Secondary risk is the removal half: `project.js`'s memo code spans four regions and a partial delete leaves dead handlers. Mitigations: verify the panel visually under **both** themes and after a live toggle — not just `GET /memo → 200`; grep `memo` in `project.html`/`project.js` to zero before calling the removal done; and leave the memo verb rail, schemas, allowlists, and ratchet baselines untouched.

## Proposed Changes

### `src/webview/memo.html` (new)

**Context.** A self-contained panel document in the shape of the existing five. It is served only by `getMemoHtml` (never opened as a VS Code webview), so it needs no `{{WEBVIEW_CSP_SOURCE}}` gymnastics beyond what the renderer substitutes.

**Logic.** Reproduce the panel preamble, then render the memo column directly (no tab bar, no `shared-tab-content` wrapper).

**Implementation.**
- `<head>`: a CSP `<meta>` matching what `getMemoHtml` returns; `@font-face` blocks for `{{HANKEN_FONT_URI}}` and `{{GEIST_PIXEL_FONT_URI}}` copied from `project.html`'s header.
- A `:root` token block defining at minimum `--text-primary`, `--text-secondary`, `--border-color`, `--accent-teal`, plus the surface/background tokens the lifted inline styles reference. Copy the values from `project.html:24+` — take the tokens the memo markup actually uses, not the whole block.
- A `body.theme-claudify` override block and a `cyber-theme-enabled` block for the same token set, so both themes render. `applyThemeClass` sets one of these two classes at generation time (`themeBodyClass.ts`).
- `.strip-btn` and `.markdown-editor` rules — copy from `project.html`. **These are the two classes the lifted markup names and they exist nowhere else.** Without them the three buttons render as unstyled native buttons.
- `<!-- SHARED_DEFAULTS_SCRIPT -->` immediately before the first `<script>`, so `injectTransportShim` replaces it with `sharedDefaults.js` + `transport.js`. Then `<script nonce="{{NONCE}}" src="{{MEMO_JS_URI}}"></script>`.
- `<body>` authored with no classes (the renderer injects `data-*` attributes and overwrites `class`); wrap content in an inner `<div>` for layout.
- The memo column, lifted from `project.html:1473–1492`: both intro `<p>` blocks verbatim, `#memo-textarea` (`class="markdown-editor"`, same `placeholder` and inline styles), `#memo-status`, and the flex row of `#memo-clear-btn` / `#memo-copy-btn` / `#memo-send-btn` (`class="strip-btn"`, teal borders on the latter two). Keep the `max-width: 720px; margin: 0 auto` centring.

> **Superseded:** "Include `transport.js` then `memo.js` (transport first, so the `window.vscode` shim exists before `memo.js` runs)."
> **Reason:** Hardcoding `<script src="/static/webview/transport.js">` diverges from the mechanism every other panel uses, skips `sharedDefaults.js`, and forfeits `injectTransportShim`'s console error when the anchor is missing (`headlessPanelHtml.ts:61–66`) — a silent failure mode that leaves `acquireVsCodeApi` undefined.
> **Replaced with:** Place `<!-- SHARED_DEFAULTS_SCRIPT -->` before the first `<script>` and let `injectTransportShim` inject both shims, exactly as `getProjectHtml`/`getDesignHtml` do. Ordering is then correct by construction.

> **Superseded:** "Carry over the `host-terminal-dispatch-false #memo-send-btn` hide rule so 'Send to Planner' hides when the host has no terminal dispatch."
> **Reason:** That rule is not in `project.html` — `transport.js` injects it into `document.head` itself when `caps.terminalDispatch === false` (`transport.js:304–328`). Copying it into `memo.html` is dead duplication.
> **Replaced with:** Nothing to add. Gating is automatic once `data-host-capabilities` is on `<body>` (which `getMemoHtml` sets). Verify by loading the standalone cockpit and confirming Send to Planner is hidden.

**Edge Cases.** Do not add a workspace dropdown. Do not add a tab bar. Do not link `shared-tabs.css` — nothing links it and it is dead.

### `src/webview/memo.js` (new)

**Context.** The memo logic extracted from `project.js`, as a standalone IIFE.

**Logic.** Identical behaviour to today; only the workspace-root source and the theme-handler addition differ.

**Implementation.**
- `const vscode = acquireVsCodeApi();` then `const WS_ROOT = decodeURIComponent(document.body.dataset.initialWorkspaceRoot || '');` — the renderer URI-encodes it (`headlessPanelHtml.ts:123` pattern), so **decode it**.
- On load: `vscode.postMessage({ type: 'memoLoad', workspaceRoot: WS_ROOT })`.
- Copy `_memoDirty` / `_memoSaveTimer` / `_debouncedMemoSave` verbatim from `project.js:1211–1223` (800 ms, `'Saved'` status that self-clears after 1500 ms), substituting `WS_ROOT` for `getProjectsTabWorkspaceRoot()`.
- Copy the four listeners verbatim from `project.js:1224–1255` — textarea `input`, `#memo-clear-btn`, `#memo-copy-btn` (`action:'copy'`), `#memo-send-btn` (`action:'send'`), preserving the cancel-timer-then-post ordering in each.
- Copy the three inbound cases verbatim from `project.js:1175–1195`: `memoContent` (with the focused-or-dirty bail intact), `memoPromptResult`, `memoError`.
- **Add** a `switchboardThemeChanged` case mirroring `project.js:409–411` → a local `handleThemeChanged(theme)` copied from `project.js`'s implementation (remove/add across `['theme-claudify','cyber-theme-enabled']` without disturbing unrelated body classes). Also accept `switchboardThemeNameSetting`, as `project.js` does.
- Do **not** post `webviewReady` — that handshake is the VS Code webview's queue-flush contract; `memo.html` has no editor host.
- Do **not** send `initiatorProject`; `project.js` doesn't, and the extension's arm resolves the authoring project itself (`TaskViewerProvider.ts:12019`).

**Edge Cases.** Guard every `getElementById` (`?.` / null check) exactly as the source does. If `WS_ROOT` is empty, still send the field — both hosts fall back safely (verified fact: `_resolveStateWorkspaceRoot`; standalone ignores it).

### `src/services/headlessPanelHtml.ts`

**Context.** The single renderer both hosts call (`TaskViewerProvider.ts:1870`, `bootstrap.ts:427`), so one edit serves the extension and `npx` alike.

**Logic.** New getter + manifest row + dispatch case.

**Implementation.**
- Add `getMemoHtml(repoRoot, workspaceRoot, capabilities?, themeClass?)` after `getSetupHtml`, modelled on `getProjectHtml` (`:167–198`):
  - candidates `dist/webview/memo.html` then `src/webview/memo.html`; not-found fallback HTML.
  - `const nonce = makeNonce();`
  - csp: `default-src 'none'; script-src 'nonce-${nonce}' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:*; frame-src 'none';`
  - **`content = content.replace(/\{\{NONCE\}\}/g, nonce);`** — the substitution the previous draft omitted. Without it every script is nonce-less and the panel is inert.
  - `{{MEMO_JS_URI}}` → `/static/webview/memo.js`; `{{HANKEN_FONT_URI}}` and `{{GEIST_PIXEL_FONT_URI}}` → the same `/static/designs/...` paths as the other getters.
  - `injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', ...)`.
  - `bodyAttr` = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="memo" data-host-capabilities="${htmlEscapeJson(JSON.stringify(caps))}"`, merged over `DEFAULT_HOST_CAPABILITIES`.
  - `applyThemeClass(content, themeClass)`; return `{ html, csp }`.
- `getPanelsManifest()` (`:313–325`): insert **after** `project` —
  `{ id: 'memo', label: 'Memo', icon: `${iconDir}/25-101-150 Sci-Fi Flat icons-118.png`, route: '/memo', enabled: true }`.
  Unconditional `enabled: true` is honest per PRD contract #6: both hosts wire all four memo verbs. Do **not** add a `memo?: boolean` key to `PanelAvailability`. The icon is cosmetic and swappable — the only hard constraint is that it not duplicate a strip entry already in use (`-78`, `-24`, `-42`, `-55`).
- `getPanelHtmlById` (`:327–336`): add `case 'memo': return getMemoHtml(repoRoot, workspaceRoot, capabilities, themeClass);`.

**Edge Cases.** No `img-src` loopback widening and no `connect-src https:` rewrite — `memo.html` loads no remote assets and carries no shared-template CSP string to patch.

### `src/services/LocalApiServer.ts`

**Context.** Two `else if` branches in `_handleRequest`.

**Implementation.**
- Panel route, next to `/project` (`:3390–3391`):
  `else if ((pathname === '/memo' || pathname === '/memo.html') && req.method === 'GET') { await this._handleServePanelById('memo', req, res); }`
- Verb route, next to `/project/verb/` (`:3300–3302`):
  `else if (pathname.startsWith('/memo/verb/') && req.method === 'POST') { const verb = decodeURIComponent(pathname.slice('/memo/verb/'.length)); await this._handlePlanningVerb(verb, req, res); }`

> **Superseded:** "Reusing `_handlePlanningVerb` is deliberate — it is the exact handler the current memo UI already uses, so behavior is identical."
> **Reason:** True but understates why it is load-bearing, which invites a later "tidy-up" to `_handleTaskViewerVerb` (superficially the better home, since the arms live on `TaskViewerProvider` and the verbs are in `TASKVIEWER_VERBS`). That refactor would break the standalone host: its memo implementation — including the headless `action:'send'` → copy degrade — lives in its **`planningVerb`** router (`bootstrap.ts:870–973`), not its `taskViewerVerb`. Routed at `taskViewerVerb`, standalone would reach the real `TaskViewerProvider` arm, which tries `dispatchCustomPromptToRole('planner', …)` against a host with zero registered terminals.
> **Replaced with:** `_handlePlanningVerb` is the **required** target, not merely a convenient one. `/memo/verb/` MUST route to the planning rail so both hosts keep their existing memo path: extension → `PlanningPanelProvider`'s memo delegation → `TaskViewerProvider`; standalone → bootstrap's inline handlers with the send→copy degrade. Do not "correct" this to the TaskViewer rail.

**Edge Cases.** Both branches are order-independent relative to each other and to the surrounding chain. `_handleServePanelById` and `_handlePlanningVerb` already enforce auth — do not add a bespoke check.

### `src/webview/project.html`

**Context.** Removal half.

**Implementation.**
- Delete the tab button at `:1232` — `<button class="shared-tab-btn" data-tab="memo">MEMO</button>`.
- Delete the comment at `:1472` and the whole `<div id="memo-content" class="shared-tab-content">` block, `:1473–1493` inclusive.
- No CSS to remove: the block styles inline, and `.memo-tab-content` has **no** rule in `project.html` (confirmed — the class is decorative). Leaving it would be harmless, but the block goes with the markup.

**Edge Cases.** `#memo-content` is the last `.shared-tab-content` before `#new-feature-modal` — remove the div and its children only; do not disturb the modal that follows.

### `src/webview/project.js`

**Context.** Removal half — four regions.

**Implementation.**
- `:52–53` — the `else if (activeTab === 'memo')` branch inside the tab click handler.
- `:1174–1195` — the memo comment plus `case 'memoContent'`, `case 'memoPromptResult'`, `case 'memoError'`.
- `:1203–1255` — the memo wiring comment block, `_memoDirty`, `_memoSaveTimer`, `_debouncedMemoSave`, and all four listeners.
- Leave `getProjectsTabWorkspaceRoot()` in place — it has other callers.

**Edge Cases.** After the edit, `grep -in memo src/webview/project.js src/webview/project.html` must return **zero** hits. A leftover `case 'memoContent'` is dead code that silently swallows the WS push the memo panel needs.

### `src/services/PlanningPanelProvider.ts` (comment only)

Update the comment at `:99–105` so it reads "…relocated from `implementation.html` to the standalone Memo panel (`memo.html`), posted at `POST /memo/verb/<verb>`". **Leave the delegation code exactly as is** — it is the only thing making memo verbs pass the `PLANNING_VERBS` guard.

## Files Touched

- **New:** `src/webview/memo.html`, `src/webview/memo.js`
- `src/services/headlessPanelHtml.ts` — `getMemoHtml`, `getPanelHtmlById` case, manifest entry
- `src/services/LocalApiServer.ts` — `/memo` serve route + `/memo/verb/` verb route
- `src/webview/project.html` — remove memo tab button + content block
- `src/webview/project.js` — remove memo load branch, message cases, element wiring
- `src/services/PlanningPanelProvider.ts` — stale comment only, no logic change

**Not touched (verified unnecessary):** `webpack.config.js` (glob copy), `src/generated/verbAllowlist.ts` / `protocol-catalog.json` (provider-keyed, not route-keyed), `src/services/verbSchemas.ts` (memo schemas exist and are permissive), `scripts/verb-return-contract-baseline.json`, `src/standalone/bootstrap.ts` (memo handlers already there), `src/webview/shell.js` / `shell.html` (manifest-driven), `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts`.

## Verification Plan

Testing is via an installed VSIX; treat `src/` as source of truth.

### Automated Tests

- **None.** Per session directive, no automated tests are run and no compilation step is performed as part of this plan's verification. All checks below are manual.

### Manual verification

1. **Panel present.** Launch the headless server and open the shell — the left strip shows a **Memo** icon with a hover label, positioned after Project. `GET /panels` includes the `memo` row with `enabled: true`; `GET /memo` returns 200 with a `Content-Security-Policy` header.
2. **Scripts actually ran.** Open the Memo iframe's console: **no CSP violation for `script-src`**, and `window.__switchboardVscodeShim` is defined. This is the check that catches a missing `{{NONCE}}` or a missing `<!-- SHARED_DEFAULTS_SCRIPT -->` marker — both of which still yield a 200.
3. **Memo works.** Existing `.switchboard/memo.md` content loads into the textarea; typing debounce-saves (status shows `Saved`, and a reload confirms persistence); **Clear** empties both textarea and file; **Copy Prompt** puts the planner prompt on the clipboard and updates the status line. Confirm in the network panel that each action is a `POST /memo/verb/<verb>` returning 200.
4. **Both hosts.** Repeat step 3 against the extension-hosted cockpit **and** `npx switchboard`. In the standalone host additionally confirm **Send to Planner** is hidden (capability gating) and that Copy Prompt still works. In the extension host confirm Send to Planner dispatches to a live planner terminal.
5. **Visual fidelity.** The three buttons render as `.strip-btn` (bordered, teal on Copy/Send) and the textarea as `.markdown-editor` — not as unstyled native controls. Intro text uses `--text-secondary`. Compare side by side against the pre-change Project → MEMO tab.
6. **Live theme sync.** With Memo active, click the shell's 🎨 toggle. The Memo panel re-themes **immediately**, in both directions (claudify → afterburner and back), matching the Board and Project panels. Then hard-reload and confirm first paint is already on the persisted theme (no flash).
7. **Deep link.** `/#memo` opens the shell with Memo selected; switching panels updates the hash; browser back/forward moves between panels.
8. **Project cleaned up.** The Project panel has no MEMO tab; every remaining tab switches with no console errors. `grep -in memo src/webview/project.js src/webview/project.html` returns nothing.
9. **Editor paths intact.** In VS Code: the sidebar's Memo sub-tab still loads and saves; `switchboard.openMemo` (command palette), the status-bar Memo button, and the memo hotkey all still reveal it.
10. **State isolation.** After using Memo, `localStorage` has an `sb-state-memo` key distinct from `sb-state-project`, and the Project panel's own state is unchanged.

---

**Recommendation:** Complexity 5 → **Send to Coder**.

## Completion Report

Implemented standalone Memo panel for headless browser app-shell mode and removed legacy MEMO tab from Project panel. Created `src/webview/memo.html` and `src/webview/memo.js` with full auto-save, clear, copy prompt, send to planner, and live theme synchronization capabilities. Updated `src/services/headlessPanelHtml.ts` to register `memo` in the panel manifest and serve its HTML, updated `src/services/LocalApiServer.ts` to add `/memo` serving and `/memo/verb/` routing branches, removed memo UI/listeners from `src/webview/project.html` and `src/webview/project.js`, and updated stale comments in `src/services/PlanningPanelProvider.ts`. No issues encountered during implementation.

