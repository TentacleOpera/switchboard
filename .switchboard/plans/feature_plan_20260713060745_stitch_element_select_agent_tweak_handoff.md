# Stitch HTML Tab: Hover-Select Element → Agent Tweak Handoff Popup

## Goal

In the STITCH HTML tab, let the user toggle an "Inspect" mode on the previewed screen, hover to highlight any element inside the rendered HTML, click to select it as context, and get a popup pinned to that element's identity (selector + HTML snippet) where they describe a tweak. The popup composes a prompt referencing the screen file on disk and the selected element, and hands it to the coding agent running in the IDE — via **Send to Agent** (agent terminal) or **Copy Prompt** (clipboard). The agent edits the file in place; the existing auto-refresh shows the result in the preview.

### Problem Analysis & Root Cause

**The problem this solves:** Stitch generates whole screens — its "Apply Edit" button does not edit the file; it makes Stitch generate a *new* file. There is no path for small, surgical tweaks to a generated screen ("make this button dark blue", "tighten this card's padding"). Today the user must leave the preview, open the generated HTML (often large, with few stable ids/classes), locate the element by eye, and hand-write an agent prompt describing both the file and the element. This feature is the **handoff point from Stitch to the IDE agent**: once a screen is close enough, tweaks happen locally against the file, not through Stitch regeneration.

**Why an injected script (root architectural constraint):** The preview iframe (`#stitch-html-preview-frame`, `design.html:3849`) is served from a per-folder localhost HTTP server (`DesignPanelProvider.ts:1423`), so it is **cross-origin** relative to the webview — the parent script cannot reach `iframe.contentDocument` to attach hover listeners. Selection logic must run *inside* the iframe as an injected script. This is already the established pattern: the server injects a Babel patch and a diagnostics script into every served HTML file (`DesignPanelProvider.ts:1614-1621`), and the diagnostics script already reports back to the parent via `window.parent.postMessage({type:'previewRenderStatus', …}, '*')`, received in the webview's main message switch (`design.js:3490`). This feature adds a third injected script on the same rails.

**Why the element descriptor matters:** Generated Stitch HTML is large and mostly anonymous (few ids, utility-class noise). A selector path plus a truncated `outerHTML` snippet lets the agent grep straight to the right node instead of reading the whole file — the descriptor is the payload that makes the handoff prompt precise.

### Background Context

- **Render paths (two, both must carry the script):** primary = localhost server URL in `iframe.src` (`_buildLocalhostUrl`, `DesignPanelProvider.ts:3684-3692`); fallback = `srcdoc` with `htmlContent: this._injectLocalCsp(fileContent)` (`DesignPanelProvider.ts:3722`). `_injectLocalCsp` (`:1677`) strips CSP metas and stamps `nonce` onto every `<script>` lacking one — injecting the inspector *before* calling it gets the nonce for free.
- **Prompt delivery exists in this provider:** `sendClaudeImportPrompt` / `sendClaudeArtifactPrompt` (`DesignPanelProvider.ts:1977-2012`) already route composed prompts through `this._taskViewerProvider.sendPromptToAgentTerminal(role, prompt, workspaceRoot)` with a clipboard fallback when `_taskViewerProvider` is absent. `sendPromptToAgentTerminal` (`TaskViewerProvider.ts:3509`) resolves the terminal registered for the role (or spawns it with the role's startup command) and delivers via the robust-text path. The `'coder'` role is the established role for code-editing agents.
- **File path availability:** `previewReady` for `stitch-html-folder` carries `filePath` (absolute, `DesignPanelProvider.ts:3716`), but the stitch-html branch of the webview handler (`design.js:1418-1465`) does not currently store it — it must be captured into state for prompt composition.
- **Auto-refresh loop:** saving the previewed file triggers an auto-refresh that reloads the iframe with a cache-buster (`design.js:1435`, `isAutoRefreshed` path). When the agent saves its tweak, the preview updates with no new plumbing. Stitch never rewrites an existing screen file (edits generate new files), so agent tweaks to this file are never clobbered by Stitch.
- **Interaction chrome already present:** hold-Space pan/zoom overlay covers the iframe while panning (`design.js:399`); zoom state key for this tab is `stitchHtml`. The edit bar is `#stitch-html-edit-bar` (`design.html:3811-3835`).

## Metadata
**Tags:** feature, ui, frontend
**Complexity:** 5

## User Review Required

None. Design decisions are made and stated below: inspect mode is toggle-based (not always-on hover), the popup is docked to the preview pane (no zoom-coordinate math in v1), the prompt routes to the `'coder'` role, and both Send-to-Agent and Copy-Prompt actions are provided.

## Complexity Audit

### Routine
- New message cases in `DesignPanelProvider._handleMessage` mirroring the existing `sendClaudeImportPrompt`/`copyClaudeImportPrompt` pairs (~20 lines).
- Edit-bar button + popup markup/CSS in `design.html` (~60 lines, inline like the rest of the panel).
- Storing `msg.filePath` in the stitch-html `previewReady` branch (1 line).

### Complex / Risky
- The injected inspector script (~100 lines of framework-free, string-embedded JS inside a TS template literal — same authoring style as `babelPatch`/`diag`, with the same escaping pitfalls).
- Cross-frame state lifecycle: the iframe reloads on every preview/auto-refresh, wiping the injected script's "inspect on" flag — the parent resets its toggle UI on each load, and between loads the button's lit state follows the frame's `sbInspectState` ack rather than optimistic local flips.
- Selector builder correctness on anonymous generated markup (uniqueness via `:nth-of-type`, verified with `querySelectorAll(sel).length === 1`).

## Edge-Case & Dependency Audit

### Race Conditions
- **Iframe reloads (preview switch, auto-refresh after agent save):** injected state is wiped. On every `previewReady` for `stitch-html-folder`, the webview must (a) reset the Inspect toggle to off, (b) hide the popup, (c) drop the stored selection — the selected node no longer exists in the reloaded DOM. **Preserve the textarea draft** (see §4): an auto-refresh landing mid-composition (agent finishing a *previous* tweak, or a user save) must not destroy typed-but-unsent instruction text.
- **Toggle before inspector installed:** the user can click Inspect while the fresh iframe is still loading — the `sbInspectToggle` postMessage lands in a document that has no listener yet and is silently dropped, leaving the button lit with no inspector running. Mitigated by the ack contract (§1/§4): the button only lights on a `sbInspectState` reply from the frame, so a dropped toggle leaves the UI honest (click again once loaded).
- **Send while a previous agent edit is in flight:** user's call — no gating; the agent terminal serializes prompts naturally (`withTerminalSendLock`).
- **Scroll after hover:** the highlight overlay is positioned on `mouseover`; scrolling inside the iframe would leave it stale. The inspector listens for `scroll` (capture, passive) while inspect is on and repositions the overlay against the current target (or hides it if the target left the viewport).

### Security
- **Forged messages:** any served HTML can post arbitrary messages to the parent (already true for `previewRenderStatus`). A forged `stitchElementSelected` only prefills a popup the user still has to author and send. Shape-check fields, coerce to strings, enforce truncation caps on receipt, and only act when the active source is `stitch-html-folder` and `event.source` is the stitch iframe's `contentWindow` (this check works in both render paths — the localhost frame is cross-origin, the srcdoc frame shares the webview origin, and `event.source` identity holds in both).
- **Prompt injection via `outerHTML`:** accepted low risk — the user reads and approves every prompt, and the agent was going to read the same file anyway.
- **Message-prefix filter (`design.js:3115`):** the webview drops `stitch*`-typed messages whose `workspaceRoot` mismatches state. Iframe-originated messages must therefore **not** carry a `workspaceRoot` field — `stitchElementSelected` with no `workspaceRoot` passes the filter untouched.

### Side Effects
- **Click swallowing:** while inspect is on, the inspector's click handler runs in the capture phase with `preventDefault()` + `stopPropagation()` so screen links/buttons don't fire. When inspect is off it must be fully inert (no listeners beyond the toggle `message` listener).
- **Space-pan overlay:** while panning, the overlay swallows mouse events, so hover highlighting pauses — acceptable, no interaction needed.
- **Zoom/pan:** the highlight overlay lives *inside* the iframe, so the tab's CSS zoom transform applies to it automatically. The popup is docked in the parent pane and needs no coordinate mapping.
- **Escape-key focus caveat:** the Escape handler lives inside the iframe and only fires while the iframe document has focus (which it has after any in-frame click). If focus is in the parent popup's textarea, Escape does nothing — the toggle button remains the authoritative exit and that is acceptable.
- **Oversized elements:** clicking `<body>` or a page-root wrapper yields a huge `outerHTML` — truncate at 2 KB with a `… [truncated]` marker; the selector + text excerpt still identify the node.
- **Double injection:** the inspector guards with a `window.__sbInspectorInstalled` flag (auto-refresh reloads make this cheap insurance, and the script also ships in the srcdoc fallback).
- **Other tabs' previews:** the HTML/Claude tabs share `_handleHtmlServerRequest`, so their frames also carry the dormant script. Harmless — nothing ever posts `sbInspectToggle` into those frames — and it leaves the door open to enabling the same feature there later.

### Dependencies & Conflicts
- **No registered coder agent:** `sendPromptToAgentTerminal('coder', …)` spawns a terminal with the coder role's startup command when none exists (`TaskViewerProvider.ts:3528-3547`); if `_taskViewerProvider` is unwired, fall back to clipboard with a notification (existing pattern). `'coder'` is a first-class workspace role (`TaskViewerProvider.ts:816`). Note `sendPromptToAgentTerminal` returns silently when `_resolveWorkspaceRoot` yields nothing (`:3510-3511`) — pass `state.stitchWorkspaceRoot` (always set while a stitch preview is up) so this path is unreachable in practice; the same residual gap exists in the Claude-prompt cases being mirrored.
- **Stitch APIs:** none — this feature never calls Stitch. It coexists with the edit bar's Stitch actions (which create *new* files and therefore never disturb the tweaked file).

## Dependencies

- None.

## Adversarial Synthesis

**Risk Summary:** The four real risks are (1) the injected script interfering with screen behavior when inspect is *off* — mitigated by making all hover/click listeners attach only on toggle-on and detach on toggle-off; (2) stale selection surviving an iframe reload and producing a prompt that references a node that no longer exists — mitigated by clearing selection/popup/toggle on every `previewReady` (textarea draft preserved); (3) toggle-state desync when the user clicks Inspect into a still-loading frame — mitigated by the `sbInspectState` ack contract (button lights only on ack); (4) template-literal escaping bugs in the string-embedded inspector script (backticks, `${`, backslashes) — mitigated by following the exact authoring conventions of the adjacent `babelPatch`/`diag` scripts and verifying with a manual load. Message forgery and prompt-injection-via-outerHTML are accepted low risks: the user authors and approves every prompt, and the agent was going to read the same file anyway. The DOM-serialized snippet may not byte-match the file source — the composed prompt explicitly tells the agent to locate structurally, not by exact-string search.

## Proposed Changes

### 1. `src/services/DesignPanelProvider.ts` — inspector script + injection (both render paths)

**Context:** `_handleHtmlServerRequest` injects `babelPatch + diag` into served HTML (`:1614-1621`); the srcdoc fallback sends `this._injectLocalCsp(fileContent)` (`:3722`).

**Logic:** Extract the inspector as a private class constant (e.g. `private static readonly _INSPECTOR_SCRIPT`) and append it to the injected bundle in `_handleHtmlServerRequest` (`const injected = babelPatch + diag + DesignPanelProvider._INSPECTOR_SCRIPT`) — the existing head-regex insertion (`:1615-1621`, gated on `mimeType.startsWith('text/html')` at `:1476`) then places it after `<head>`.

> **Superseded:** In the srcdoc path, prepend it to the file content *before* `_injectLocalCsp` so the nonce regex stamps it: `htmlContent: isHtmlFile ? this._injectLocalCsp(DesignPanelProvider._INSPECTOR_SCRIPT + fileContent) : undefined`.
> **Reason:** Raw prepending puts a `<script>` token *before* `<!DOCTYPE html>`, which displaces the doctype during parsing (the parser drops a late doctype token). srcdoc documents are spec-exempt from the quirks-mode fallback, so this probably renders fine — but it needlessly depends on that spec subtlety, and it diverges from every existing injection in this codebase (the server path `:1615-1621` and the webview's `injectBaseTag`, `design.js:452-467`, both insert after `<head>` with `<html>`/prepend fallbacks).
> **Replaced with:** Extract a tiny private helper `_injectIntoHead(html: string, snippet: string): string` implementing the same insertion ladder as `:1615-1621` (after `<head>` → after `<html>` → prepend). Use it in *both* paths: `_handleHtmlServerRequest` calls `this._injectIntoHead(html, babelPatch + diag + DesignPanelProvider._INSPECTOR_SCRIPT)`, and the srcdoc path becomes `htmlContent: isHtmlFile ? this._injectLocalCsp(this._injectIntoHead(fileContent, DesignPanelProvider._INSPECTOR_SCRIPT)) : undefined` — still ahead of `_injectLocalCsp` so the nonce regex (`:1680`) stamps the inspector's `<script>` tag.

**Inspector behavior (inside the iframe):**
- Idempotence guard: `if (window.__sbInspectorInstalled) return; window.__sbInspectorInstalled = true;`
- Dormant by default. Listens for `message` events shaped `{type:'sbInspectToggle', on:boolean}` and attaches/detaches its `mouseover`/`mouseout`/`click`/`keydown`/`scroll` listeners accordingly. **After applying any state change it posts `{type:'sbInspectState', on:boolean}` to the parent** — this single ack message drives the parent's toggle-button state (see §4) and closes the toggle-before-install race: a toggle posted into a still-loading frame is dropped, no ack arrives, and the button stays honest.
- **Hover:** positions a single reusable highlight overlay (`position:fixed`, `pointer-events:none`, translucent fill + 1px outline, max z-index) over the hovered element's `getBoundingClientRect()`, with a small tag label (`div.hero > button.cta`) clamped inside the viewport. No mutation of target element styles.
- **Click (capture phase, `preventDefault` + `stopPropagation`):** builds the descriptor and posts to parent:
  ```js
  window.parent.postMessage({
    type: 'stitchElementSelected',
    selector,                    // built by walking up: #id short-circuits; else tag.classes with :nth-of-type when needed; verified unique via querySelectorAll(sel).length === 1; depth-capped
    tag, id, classes,            // strings/arrays, raw
    text,                        // trimmed textContent, capped ~200 chars
    outerHTML,                   // capped 2048 chars + '… [truncated]' marker
  }, '*');
  ```
> **Superseded:** **Escape key:** exits inspect mode locally and posts `{type:'stitchInspectExited'}` so the parent syncs its toggle button.
> **Reason:** With the `sbInspectState` ack (above) driving the button, a second exit-only message type is redundant — two messages meaning "my state changed" invite drift.
> **Replaced with:** **Escape key:** exits inspect mode locally and posts the same `{type:'sbInspectState', on:false}` ack; the parent has exactly one message that syncs the toggle button.

**Edge Cases:** Script is authored in the same escaped-template-literal style as `babelPatch` — no backticks or `${` inside the embedded JS. SVG elements: `classList` on SVG returns `SVGAnimatedString` via `className` — use `getAttribute('class')` when building selectors.

### 2. `src/services/DesignPanelProvider.ts` — prompt delivery message cases

**Context:** Mirror of `sendClaudeImportPrompt`/`copyClaudeImportPrompt` (`:1969-2012`).

**Implementation:**
```ts
case 'copyStitchTweakPrompt': {
    const prompt = String(message.prompt || '');
    if (!prompt) break;
    await vscode.env.clipboard.writeText(prompt);
    showTemporaryNotification('Copied element tweak prompt to clipboard.');
    break;
}

case 'sendStitchTweakPrompt': {
    const prompt = String(message.prompt || '');
    if (!prompt) break;
    if (this._taskViewerProvider) {
        await this._taskViewerProvider.sendPromptToAgentTerminal('coder', prompt, message.workspaceRoot || undefined);
        showTemporaryNotification('Sent element tweak prompt to agent terminal.');
    } else {
        await vscode.env.clipboard.writeText(prompt);
        showTemporaryNotification('Agent terminal unavailable — copied tweak prompt to clipboard instead.');
    }
    break;
}
```

**Edge Cases:** None beyond the existing pattern; `sendPromptToAgentTerminal` handles missing/spawned terminals internally.

### 3. `src/webview/design.html` — Inspect toggle + tweak popup markup

**Context:** Edit bar `#stitch-html-edit-bar` (`:3811-3835`); preview pane `#preview-pane-stitch-html`.

**Logic:**
- Add `<button id="stitch-html-btn-inspect" class="preview-overlay-btn">Inspect</button>` to the edit bar row (before Apply Edit). Toggled-on state gets an `.active` accent style.

> **Superseded:** Add the popup inside `#preview-pane-stitch-html`, hidden by default, docked top-right of the preview area (`position:absolute`).
> **Reason:** `#preview-pane-stitch-html` (`design.html:3810`) has no `position` set, so an absolutely-positioned child would anchor to some ancestor instead. Meanwhile `#stitch-html-preview-wrapper` is a `.zoomable-container`, which is already `position:relative` (`design.html:1985`) — and the zoom transform applies only to its `.zoomable-viewport` child, so a sibling of the viewport is naturally exempt from zoom.
> **Replaced with:** Add the popup as a direct child of `#stitch-html-preview-wrapper` (sibling of `.zoomable-viewport`), hidden by default, `position:absolute; top:12px; right:12px; z-index:20` — above the `.zoom-event-layer` (z-index 5) and `.zoom-toolbar` (z-index 10). The wrapper is only visible while a preview is up, which is exactly the popup's valid lifetime.

- Popup structure, styled like the existing variants dropdown (panel bg, border, shadow):
  - **Header:** element breadcrumb (e.g. `div.hero > button.cta`) + close ✕.
  - **Context block:** collapsed `<details>` showing the (truncated) HTML snippet in a `<pre>` with `overflow:auto`.
  - **Textarea:** `#stitch-tweak-input`, placeholder `Describe the change to this element, e.g. 'make it dark blue'…`.
  - **Actions:** `#stitch-tweak-btn-send` ("Send to Agent", primary) and `#stitch-tweak-btn-copy` ("Copy Prompt").

**Edge Cases:** Popup width capped (~340px) with `max-height` + internal scroll so giant snippets can't overflow the pane. No confirmation dialogs anywhere (project rule).

### 4. `src/webview/design.js` — toggle wiring, selection handling, prompt composition

**Context:** stitch-html `previewReady` branch (`:1418-1465`), main message switch, edit-bar wiring region (`:4466+`).

**Logic:**

*State & path capture:* in the stitch-html `previewReady` branch, store `state.stitchHtmlActiveFilePath = msg.filePath || null;` and reset the feature: toggle off (button class + no message needed — the fresh iframe is dormant by default), hide popup, `state.stitchSelectedElement = null`. **Do not clear `#stitch-tweak-input`** — an auto-refresh landing mid-composition (e.g. the agent finishing a previous tweak) must not eat the user's typed draft; the draft survives hidden and reappears on the next selection. The input is cleared only when the user closes the popup with ✕.

*Toggle:* `#stitch-html-btn-inspect` click posts the *desired* state into the frame (the inverse of the button's current `.active` state) and does **not** flip the button itself — the `sbInspectState` ack does that:
```js
const frame = document.getElementById('stitch-html-preview-frame');
const btn = document.getElementById('stitch-html-btn-inspect');
frame?.contentWindow?.postMessage({ type: 'sbInspectToggle', on: !btn.classList.contains('active') }, '*');
```

*Message cases* (the handler closure already has `event` in scope for source checks — the main listener is `window.addEventListener('message', (event) => …)` at `design.js:3110`):
- `stitchElementSelected`: ignore unless `state.activeSource === 'stitch-html-folder'` and `event.source` is the stitch frame's `contentWindow`. Shape-check/coerce fields, re-truncate (`outerHTML` 2048, `text` 200), store as `state.stitchSelectedElement`, render breadcrumb + snippet into the popup, show it, focus the textarea. (Neither iframe message carries a `workspaceRoot` field, so the `stitch*` root-mismatch filter at `design.js:3115` passes them through.)
- `sbInspectState`: same source check; set the toggle button's `.active` class from `msg.on`. This is the *only* writer of the button's visual state after a click — the click handler posts the desired state into the frame and waits for this ack (see Race Conditions audit).

*Prompt composition + actions:*
```js
function composeStitchTweakPrompt() {
    const el = state.stitchSelectedElement;
    const filePath = state.stitchHtmlActiveFilePath;
    const instruction = document.getElementById('stitch-tweak-input')?.value.trim();
    if (!el || !filePath || !instruction) return '';
    return [
        'Tweak a generated Stitch screen file in place.',
        '',
        'File: ' + filePath,
        '',
        'Target element (CSS selector: ' + el.selector + '):',
        '```html',
        el.outerHTML,
        '```',
        '',
        'Requested change: ' + instruction,
        '',
        'The snippet above is serialized from the live DOM — whitespace, entity encoding, attribute quoting, and boolean-attribute forms may differ from the file bytes, and if the page builds DOM at runtime the element may not appear verbatim in the source. Locate the target by the selector and the element\'s structure/text, not by exact-string search.',
        '',
        'Edit the file directly. Keep the change scoped to this element unless it forces adjacent updates (e.g. shared CSS). Do not create a plan file — this is a direct edit.'
    ].join('\n');
}
```
- Send button → `vscode.postMessage({ type: 'sendStitchTweakPrompt', prompt, workspaceRoot: state.stitchWorkspaceRoot })`; Copy button → `{ type: 'copyStitchTweakPrompt', prompt }`. Empty instruction → inline status nudge in the popup (reuse `setStitchHtmlStatus` styling), no dialogs. Popup stays open after send so the user can watch the auto-refresh land and iterate; the selection block persists until reload clears it.

**Edge Cases:** If the user switches Stitch projects or tabs mid-selection, the `previewReady` reset path clears the selection, popup, and toggle (the textarea draft is preserved per the reset rule above). If Send fires while a previous agent edit is still in flight, that's the user's call — no gating (the agent terminal serializes naturally).

## Verification Plan

> Automated tests and compilation are **not** run as part of this planning pass. Steps below are for the implementer.

### Automated Tests
- No existing harness drives the webview iframe. `node --check` on `design.js`; the TS build gates `DesignPanelProvider.ts`. If a jsdom-style unit exists for prompt builders, cover `composeStitchTweakPrompt` truncation and empty-field returns.

### Manual Verification
1. Open a Stitch project's screen in the STITCH HTML tab → edit bar shows the new **Inspect** button.
2. Toggle Inspect → hovering highlights elements with the breadcrumb label; highlight tracks zoom/pan correctly (it lives inside the iframe).
3. Click a button/card → popup opens docked top-right with breadcrumb, collapsible HTML snippet, and textarea; the screen's own link/button did **not** activate.
4. Escape exits inspect mode and the toggle button un-lights.
5. Type a tweak → **Copy Prompt** puts the full composed prompt (file path, selector, snippet, instruction) on the clipboard.
6. **Send to Agent** delivers to the coder terminal (spawns it if absent); agent edits the file; preview auto-refreshes and shows the tweak; popup/selection cleared by the reload.
7. With inspect **off**, the screen behaves exactly as before (links work, no highlight).
8. Switch screens/projects mid-selection → popup closes, toggle resets, no stale selection.
9. Kill the localhost server path (or force the srcdoc fallback) → inspector still works in srcdoc mode, and the previewed page still renders identically (head-insertion, not prepend).
10. Select `<body>` → snippet is truncated with marker, popup layout holds.
11. Click Inspect immediately after switching screens (iframe still loading) → button does **not** light until the frame acks; a second click once loaded works normally.
12. Type a draft, then save the previewed file externally to force an auto-refresh → popup hides, selection clears, but re-selecting an element shows the draft still in the textarea.
13. With inspect on, scroll inside the screen → the highlight tracks (or hides) instead of floating detached.

## Recommendation

**Send to Coder** (complexity 5). The rails (script injection, iframe→parent postMessage, agent-terminal delivery with clipboard fallback, auto-refresh) all exist and are cited by line — every reference re-verified against source on 2026-07-13; the new work is one self-contained injected script plus popup UI. The escaping conventions of the embedded script, the reload-reset lifecycle (with draft preservation), and the `sbInspectState` ack contract are the places to be careful.

## Completion Report

Implemented inspector script injection in DesignPanelProvider.ts. Created overlay toggle and element click listener. Added Inspect button and hover-select tweak popup to design.html. Connected postMessage events and command dispatch in design.js. Files changed: DesignPanelProvider.ts, design.html, design.js. No issues encountered during implementation.
