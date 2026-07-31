# Browser Terminals Panel: xterm.js Rail Tab in the Standalone Shell

## Goal

Add a **Terminals** panel to the browser shell — visible only in the standalone host — where the user can create, view, type into, and close PTY fleet terminals rendered with xterm.js. Depends on the PTY fleet backend and the WebSocket I/O channel subtasks.

### Problem analysis / root cause

The browser shell (`src/webview/shell.html` + `shell.js`) mounts panels as simultaneously-live same-origin iframes from a server-side manifest (`src/services/headlessPanelHtml.ts:353-369`, six panels today: board, project, memo, planning/Artifacts, design, setup), each panel keeping its own WebSocket. There is no terminal surface anywhere in the browser because there was nothing to show: standalone had no terminals, and the extension host's VS Code terminals cannot be mirrored (no stable VS Code API exposes terminal output). With the PTY fleet and WS channel in place, the missing piece is purely frontend: an xterm.js panel wired to `/ws/terminal`.

### Hard constraint — user directive 2026-07-31

**Standalone-only.** The panel is gated by a fail-closed availability flag: the extension host never enables it, so the VS Code-hosted browser shell shows no Terminals icon. VS Code mode keeps VS Code terminals; no mirroring is attempted.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, feature

## User Review Required

- **Vendor copy strategy:** the sql.js precedent and the dev-flow src/ fallback must be reconciled — the plan now requires ONE named copy strategy (see step 1) rather than two hand-synced mirrors. Confirm the chosen approach before coding.
- Kept-alive xterm instances parse all output even while their panel iframe is backgrounded; with several busy agents this burns CPU in the background. Accepted for v1 (matches the shell's keep-everything-live philosophy); flag if a throttle is wanted.

## Complexity Audit

### Routine
- New panel HTML/JS following the memo-panel precedent (browser-only, no VS Code provider counterpart).
- Manifest entry + route registration follow five existing examples each.
- Icon follows the established `icons/nav-*.svg` + `buildMaskedGlyph` (`shell.js:46-52`) system.
- Theme fan-out subscription mirrors existing panels (`switchboardThemeChanged`, `shell.js:122-134`).
- Role picker uses the existing generic `getSetting` verb (standalone arm at `bootstrap.ts:617`) to read `agents.visibleAgents` — verified to exist; no new verb needed.

### Complex / Risky
- Vendored xterm must work under the strict CSP (nonce'd script tags, no CDN) in BOTH the dist-served and src-served flows — two serving paths, one bug class (stale mirror).
- Reconnect + seq-dedup correctness against the gateway's replay protocol — a dedup bug shows as duplicated or missing terminal output.
- Scrollback replay bursts (up to 256 KB) must not jank the UI thread with per-frame synchronous xterm writes.
- The 1.7.13 shim-injection regression class: a panel can render while its transport is silently broken — marker discipline is load-bearing.
- Fail-closed gating is stricter than the `!== false` pattern used by `planning` — easy to get subtly wrong by copying the wrong precedent.

## Edge-Case & Dependency Audit

**Race Conditions**
- Reconnect during active output: server replays scrollback then live frames; client dedups by `seq` — overlapping reconnects must not create two sockets feeding one xterm instance (guard: single reconnect timer + close-before-reconnect).
- Terminal closed while viewed: gateway sends `{t:'exit'}` → mark the instance exited, keep scrollback visible, disable input.
- Rapid create/close churn via toolbar: `terminalsChanged` bursts must not race an in-flight `ptyListTerminals` response (last-write-wins on the list render).

**Security**
- Cookie auth rides the same-origin WebSocket automatically; no token handling in page JS.
- xterm rendering of untrusted agent output: xterm.js handles escape-sequence safety; do NOT inject terminal text into the DOM outside xterm. Research flagged terminal escape-sequence injection as an active CVE class (e.g. OSC color-query abuse) — pin a modern `@xterm/xterm` (v5.5+/v6, legacy CVEs resolved), keep xterm's default parser behavior, and never register custom automated response handlers that act on raw PTY output.
- CSP: vendor scripts only via the per-render nonce mechanism (`src/services/headlessPanelHtml.ts:50-52`); no new CSP sources.

**Side Effects**
- Kept-alive instances consume CPU/memory per terminal while the panel iframe lives (shell keeps all panel iframes alive).
- `term.resize` on panel visibility changes can flood `{t:'resize'}` frames — debounce with the fit addon + ResizeObserver.

**Dependencies & Conflicts**
- Depends on the WS channel subtask's frame protocol (`/ws/terminal`, `{t:'out'|'input'|'resize'|'exit'}`, per-connection `seq`, replay-before-live) and `terminalsChanged` hub broadcast.
- Depends on the fleet backend subtask's verbs (`ptyCreateTerminal`, `ptyCloseTerminal`, `ptyListTerminals`, `ptyRenameTerminal`) and the `terminalFleet` capability — **reconciled ownership:** the backend subtask flips `terminalFleet`; THIS plan sets `availability.terminals` only.
- `PanelAvailability` (`src/services/headlessPanelHtml.ts:347-351`) currently has only `design`/`setup`/`planning` — this plan adds the `terminals` field.
- Dev-flow serving: `_handleServeStatic` (`LocalApiServer.ts:782-830`) tries dist/ then src/; the vendor files must resolve in both.

## Dependencies

- None recorded (no prior research sessions).

## Adversarial Synthesis

Key risks: a hand-synced src-mirror of vendored xterm rotting against the dist copy; per-frame xterm writes janking on 256 KB replay bursts; reconnect dedup bugs duplicating output. Mitigations: one named vendor copy strategy verified against the sql.js precedent, batched replay writes, single-socket reconnect discipline, and the established shim-injection + scrollbar contract surfaces extended to the new panel.

## Non-Goals

- No Terminals panel in the extension-hosted browser (`availability.terminals` stays false there).
- No terminal search/links/serialize addons in v1 — xterm core + fit only.
- No dispatch buttons inside this panel (dispatch arrives via the board in the dispatch subtask; this panel is for viewing/interacting).

## Implementation Steps

### 1. Vendor xterm.js

- Add `@xterm/xterm` + `@xterm/addon-fit` as dependencies (pin published versions ≥ 7 days old; use a current v5.5+/v6 line — legacy escape-handling CVEs are resolved in modern releases). Serve them as static assets: extend the webpack `CopyPlugin` config (sql.js precedent at `webpack.config.js:94-100`) to copy the dist JS/CSS into `dist/webview/vendor/xterm/`.
- **Exact assets (confirmed by research 2026-07-31):** `@xterm/xterm` ships `lib/xterm.js` (UMD → `window.Terminal`) + `css/xterm.css`; `@xterm/addon-fit` ships `lib/addon-fit.js` (UMD → `window.FitAddon.FitAddon`). All three are plain script-tag-consumable without a bundler and compatible with nonce-only CSP (no `unsafe-inline`/`unsafe-eval` needed). Copy exactly these three files.
- **Copy strategy (clarification):** the dev flow serves from `src/` when `dist/` is absent (`_handleServeStatic` dist→src fallback, `LocalApiServer.ts:782-830`). Rather than hand-mirroring a second copy under `src/` (two copies, guaranteed to rot), the coder must FIRST check how the sql.js assets handle the src-fallback case and adopt the SAME strategy for xterm; if sql.js is mirrored-and-rotting, prefer making the dev flow run the same copy step (or a tiny `scripts/` sync) so there is exactly one source of truth. Record the chosen strategy in the plan's implementation notes.
- Load via `<script nonce="{{NONCE}}" src="/static/webview/vendor/xterm/xterm.js">` — the CSP nonce mechanism already exists per-render (`src/services/headlessPanelHtml.ts:50-52`). No CDN, ever (CSP forbids it and the VSIX/npm package must be self-contained).

### 2. Panel HTML/JS (`src/webview/terminals.html`, `src/webview/terminals.js`)

- Follow the memo panel precedent — a browser-only panel served exclusively by `headlessPanelHtml` (`getMemoHtml`, `src/services/headlessPanelHtml.ts:315-337`) with no VS Code provider counterpart. Include the `<!-- SHARED_DEFAULTS_SCRIPT -->` marker so transport-shim injection lands correctly (the 1.7.13 regression documented in `src/test/webview-shim-injection-contract.test.js` is the cautionary tale).
- Layout: left column lists fleet terminals (friendly name, role badge, live/exited status dot); main area hosts one xterm instance per terminal (created lazily on first view, kept alive on tab switch — same keep-state philosophy as the shell's iframe model). Toolbar: **New Terminal** (role picker populated from the `agents.visibleAgents` config via the existing generic `getSetting` verb — standalone arm at `bootstrap.ts:617`), rename (inline), close (immediate — **NEVER a confirm dialog**, per project rule).
- Terminal list stays fresh via the `terminalsChanged` hub broadcast (delivered through the existing transport WS envelope) plus an initial `ptyListTerminals` verb call. Churn discipline: last-write-wins list render; an in-flight list response must not overwrite a newer `terminalsChanged` state.
- I/O wiring per terminal: browser-native `WebSocket` to `/ws/terminal?name=…` (cookie auth rides along, same-origin); `{t:'out'}` frames → base64-decode → `term.write()`, dedup by `seq` across reconnects; `term.onData` → `{t:'input'}`; fit-addon + `ResizeObserver` (debounced) → `{t:'resize'}`. Reconnect with exponential backoff mirroring `transport.js:177-184` (500ms → 30s, constants at :59-60), replaying scrollback on re-attach (server sends it; `seq` dedupe makes it idempotent). **Replay batching:** on attach, buffer incoming replay frames and flush to xterm in batches (e.g. per animation frame or per N frames) rather than one synchronous `term.write` per frame — a 256 KB replay is hundreds of frames and must not jank the UI thread.
- **Exit handling:** on `{t:'exit'}` keep the scrollback visible, mark the tab exited, disable input.
- Theme: subscribe to the shell's `switchboardThemeChanged` fan-out (`shell.js:122-134`) and map the shell palette to an xterm theme object (background, foreground, cursor, selection); re-apply live on toggle. **Scope note:** this themes only the xterm base surface — agent TUIs emit their own 256-color escapes which are unaffected by the theme object (expected, not a bug).

### 3. Manifest + routes + capability gate

- `src/services/headlessPanelHtml.ts`: add `getTerminalsHtml()` and a manifest entry `{ id: 'terminals', label: 'Terminals', route: '/terminals', icon: '/static/icons/nav-terminals.svg' }` gated `enabled: availability.terminals === true` — **fail-closed** (note this is stricter than the `!== false` pattern used by `planning`/`setup`/`design` at :354-356; absence must mean hidden). Add `terminals?: boolean` to `PanelAvailability` (:347-351).
- `LocalApiServer.ts` route table: `/terminals` → `_handleServePanelById('terminals')` following the existing panel-route pattern at `LocalApiServer.ts:3393-3402` (auth-gated like the other panel routes).
- Standalone `bootstrap.ts` passes `availability.terminals: true` in its `sharedGetPanelsManifest` call (currently `{ design: true, setup: true }` at `bootstrap.ts:420`); the extension's manifest wiring (`TaskViewerProvider.ts:1874`, `{ design: true, setup: true, planning: true }`) passes nothing → hidden. **Reconciled ownership:** the `terminalFleet: true` capability flip is owned by the fleet backend subtask (`bootstrap.ts:388`) — do NOT duplicate it here; this plan's only capability surface is `availability.terminals`.
- Icon: new `icons/nav-terminals.svg` following the established rail-icon system — codicon-shaped single-color sci-fi SVG rendered via CSS `mask-image` + `currentColor` in `shell.js`'s `buildMaskedGlyph` (:46-52) (the PNG approach is the rejected pattern; siblings: `nav-board`, `nav-memo`, `nav-setup`, etc.).

## Proposed Changes

### `src/webview/terminals.html` + `src/webview/terminals.js` (new)
- **Context:** Memo-panel precedent; browser-only surface.
- **Logic:** Two-pane layout (list + xterm host), toolbar verbs, per-terminal socket lifecycle, seq-dedup, batched replay, theme fan-out.
- **Implementation:** Carry the `SHARED_DEFAULTS_SCRIPT` marker exactly once; nonce'd vendor script tags.
- **Edge cases:** Exited terminal read-only view; reconnect storms; churn vs in-flight list; hidden-panel CPU cost accepted.

### `src/services/headlessPanelHtml.ts`
- **Context:** Manifest (:353-369) and `PanelAvailability` (:347-351) gate panel visibility.
- **Logic:** Add `terminals?: boolean`; `getTerminalsHtml()`; manifest entry with fail-closed `=== true` gate.
- **Edge cases:** Absence/undefined ⇒ hidden (unlike the `!== false` panels).

### `src/services/LocalApiServer.ts` (route table :3393-3402)
- **Context:** Five existing `_handleServePanelById` routes.
- **Logic:** Add `/terminals` route, auth-gated identically.
- **Edge cases:** None new — pattern reuse.

### `webpack.config.js` (CopyPlugin, sql.js precedent :94-100)
- **Context:** Vendor assets must ship in dist AND resolve in the src-served dev flow.
- **Logic:** Copy `@xterm/xterm` dist JS/CSS + fit addon into `dist/webview/vendor/xterm/`; adopt the sql.js src-fallback strategy (one source of truth — see step 1).
- **Edge cases:** No hand-synced duplicate copies.

### `src/standalone/bootstrap.ts` (:420)
- **Context:** Standalone manifest call currently `{ design: true, setup: true }`.
- **Logic:** Add `terminals: true`. Do NOT touch `terminalFleet` (backend subtask owns it at :388).
- **Edge cases:** Extension manifest call unchanged → panel hidden there.

### `icons/nav-terminals.svg` (new)
- **Context:** Rail icons are masked single-color SVGs (`buildMaskedGlyph`, `shell.js:46-52`).
- **Logic:** New codicon-shaped terminal glyph.
- **Edge cases:** Must render via `mask-image` + `currentColor`, not embedded fills/PNG.

## Resolved Assumptions

Resolved by web research (2026-07-31) — authoritative, do not re-open:

1. **xterm vendoring is feasible without a bundler.** `@xterm/xterm` ships `lib/xterm.js` (UMD → `window.Terminal`) + `css/xterm.css`; `@xterm/addon-fit` ships `lib/addon-fit.js` (UMD → `window.FitAddon.FitAddon`). Plain `<script nonce>` loading works under strict CSP; no `unsafe-inline`/`unsafe-eval` required. Exact copy list written into step 1.
2. **Security posture:** legacy xterm escape-handling CVEs are resolved in modern releases (v5.5+/v6); terminal escape-sequence injection remains an active CVE class generally, so custom automated response handlers on raw PTY output are forbidden (noted in Security audit).

## Verification Plan

Per session directives (SKIP COMPILATION / SKIP TESTS), this verification plan does **not** include running any project compilation step or automated test suite. Verification is manual UAT plus code-review checkpoints. (The contract-test ideas named in the steps — shim-injection marker extension, manifest fail-closed gating, scrollbar contract inclusion — are recorded as requirements for the automated suite, to be written and run outside this session's scope.)

- **Code-review checkpoints:**
  - `terminals.html` carries exactly one `SHARED_DEFAULTS_SCRIPT` marker; vendor scripts loaded with the per-render nonce; no CDN URLs anywhere.
  - Manifest gate is `availability.terminals === true` (fail-closed), not `!== false`.
  - Vendor assets exist in dist AND resolve via the src-served dev path with ONE copy strategy.
  - `bootstrap.ts` manifest call adds `terminals: true`; extension manifest call untouched; `terminalFleet` not set here (backend owns it).
  - Reconnect: single socket per terminal; `seq` dedup present; replay batched.
- **Manual UAT (darwin):** `npx switchboard` → Terminals icon appears in the rail → New Terminal (coder) → claude TUI renders and is interactive (arrow keys, colors) → resize the window and the TUI reflows → toggle theme and colors follow → refresh the page and the terminal re-attaches with scrollback → open the same terminal in a second tab and both stay live. Dev flow (no dist build): panel and vendor assets still load. From VS Code's Open in Browser: no Terminals icon.

## Completion Report

Created `src/webview/terminals.html` and `src/webview/terminals.js` incorporating xterm.js and fit-addon UMD rendering, debounced `ResizeObserver`, WebSocket I/O streaming, seq-deduplication, and `requestAnimationFrame` replay batching. Added `@xterm/xterm` and `@xterm/addon-fit` dependencies and configured webpack CopyPlugin. Registered `getTerminalsHtml()`, fail-closed `availability.terminals === true` manifest gate in `src/services/headlessPanelHtml.ts`, `/terminals` route in `src/services/LocalApiServer.ts`, rail icon `icons/nav-terminals.svg`, and enabled `terminals: true` in `src/standalone/bootstrap.ts`. No issues encountered.

