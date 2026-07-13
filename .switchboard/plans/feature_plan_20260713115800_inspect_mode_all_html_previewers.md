# Inspect Mode for All HTML Previewers

## Goal

Generalize the Stitch HTML tab's "Inspect Mode" feature (hover-select element → tweak popup → send to agent) to **every** HTML preview surface in the extension:

1. **Design panel → HTML Previews tab** (`html-folder` source in `design.html`/`design.js`)
2. **Planning panel → HTML tab** (`planning-html-folder` source in `planning.html`/`planning.js`)

The Stitch HTML tab already has this feature (implemented per `feature_plan_20260713060745`). The inspector script (`_INSPECTOR_SCRIPT` in `DesignPanelProvider.ts`) is already injected into Design panel previews via `_buildAndSendPreview` (both server + srcdoc paths). The Planning panel has neither the injection nor the UI.

### Problem Analysis & Root Cause

**Design panel HTML tab:** The inspector script is already injected into `html-folder` previews — `_buildAndSendPreview` (`DesignPanelProvider.ts:3984`) calls `this._injectIntoHead(fileContent, DesignPanelProvider._INSPECTOR_SCRIPT)` for the srcdoc path, and the server path (`_handleHtmlServerRequest`, `:1861`) appends it to the `babelPatch + diag` bundle. What's missing is the **UI**: no Inspect Mode button in the controls strip, no tweak popup, no message handlers for `stitchElementSelected`/`sbInspectState` scoped to `html-folder`, and no prompt composition/send handlers.

**Planning panel HTML tab:** Neither the inspector script injection nor the UI exists. `PlanningPanelProvider._buildAndSendPlanningHtmlPreview` (`:2059`) sends `htmlContent: this._injectLocalCsp(fileContent)` with no inspector injection. The server path (`_handlePlanningHtmlServerRequest`, `:1957-1967`) serves raw file bytes with no script injection at all. The webview (`planning.html`/`planning.js`) has no Inspect button, no tweak popup, and no message handlers.

### Background Context

- **Inspector script:** `DesignPanelProvider._INSPECTOR_SCRIPT` (`:126-361`) — a self-contained, framework-free JS string that listens for `sbInspectToggle` postMessage, attaches hover/click/scroll listeners, builds a CSS selector + truncated outerHTML descriptor, and posts `stitchElementSelected` back to the parent. Idempotence-guarded with `window.__sbInspectorInstalled`.
- **Existing Stitch HTML implementation (reference):**
  - Button: `#stitch-html-btn-inspect` in controls strip (`design.html:3808`)
  - Popup: `#stitch-tweak-popup` in `#stitch-html-preview-wrapper` (`design.html:3860-3877`)
  - Toggle wiring: `design.js:4568-4577`
  - Message handlers: `stitchElementSelected` (`design.js:3499-3548`), `sbInspectState` (`design.js:3551-3565`)
  - Prompt composition: `composeStitchTweakPrompt()` (`design.js:4587-4609`)
  - Send/copy: `design.js:4611-4656`
  - Provider handlers: `sendStitchTweakPrompt`/`copyStitchTweakPrompt` (`DesignPanelProvider.ts:2210-2229`) — both use `showTemporaryNotification(...)` for confirmation; they do **not** post a message back to the webview.
- **Design panel HTML tab controls strip:** `#controls-strip-html` (`design.html:3893-3901`) — has workspace filter, search, status, and Claude artifact buttons.
- **Planning panel HTML tab controls strip:** `#controls-strip-planning-html` (`planning.html:3641-3648`) — has workspace filter, search, status, and Claude artifact buttons.
- **Planning panel iframe:** `#planning-html-frame` inside `#planning-html-preview-wrapper` (`planning.html:3670-3672`).
- **Planning panel provider:** Has `_taskViewerProvider` (`:197`) with `sendPromptToAgentTerminal` access — same pattern as Design panel. Has `_injectLocalCsp` (`:1830`) but no `_injectIntoHead` helper. Already imports `showTemporaryNotification` (`:6`).
- **Planning panel server:** `_handlePlanningHtmlServerRequest` (`:1928-1974`) serves raw bytes — no babel patch, no diag script, no inspector. The deny list check (`:1948-1955`) uses `normalizedResolved.split(path.sep)` on the absolute path (not relative to source folder like the Design panel's fixed version at `:1690-1701`), which 403's any file under a `.switchboard` path — but planning HTML folders are user-configured, not under `.switchboard`, so this is not a blocker for the feature (though it is a latent bug if a user configures a folder under `.switchboard`).
- **Message filter:** Planning panel's `window.addEventListener('message', …)` (`planning.js:4334`) only filters `ticketsMsgTypes` (`:4338-4347`) — there is no `stitch*` workspaceRoot filter (unlike `design.js:3124`), so `stitchElementSelected`/`sbInspectState` messages pass through with no special handling needed.
- **Design panel message filter:** `design.js:3124` drops messages whose `type` starts with `stitch` **only if** `msg.workspaceRoot` is present and mismatches `state.stitchWorkspaceRoot`. The inspector's `stitchElementSelected`/`sbInspectState` carry no `workspaceRoot` field, so they pass through untouched (empirically true — the Stitch HTML tab works under this filter).
- **HTML preview surfaces (complete inventory):** Exactly three sandboxed HTML preview iframes exist in the webview: `#stitch-html-preview-frame` (design.html:3858, already has Inspect Mode), `#html-preview-frame` (design.html:3924, Design HTML Previews tab), `#planning-html-frame` (planning.html:3672, Planning HTML tab). The plan covers all three (1 existing + 2 new) — no other HTML preview surfaces exist.
- **Workspace-root state fields (verified):** Design panel uses `state.designWorkspaceRootFilter` (design.js:32) — there is no `state.designWorkspaceRoot`. Planning HTML uses `state.planningHtmlWorkspaceRootFilter` (planning.js:2005) — there is no `state.workspaceRoot`.

## Metadata
**Tags:** feature, ui, frontend
**Complexity:** 4

## User Review Required

None. The feature is a direct generalization of the existing Stitch HTML implementation. Design decisions follow the established pattern: Inspect Mode button in the controls strip (not the edit bar), popup docked top-right of the preview wrapper, prompt routes to the `coder` role, both Send-to-Agent and Copy-Prompt actions provided, confirmation via `showTemporaryNotification` (mirroring the Stitch HTML provider handlers).

## Complexity Audit

### Routine
- Adding an Inspect Mode `<button>` to two existing controls strips (`#controls-strip-html`, `#controls-strip-planning-html`) — same markup pattern as `#stitch-html-btn-inspect`.
- Adding a tweak popup `div` to two existing preview wrappers — clone of `#stitch-tweak-popup` (`design.html:3860-3877`) with prefixed IDs.
- Adding `case 'stitchElementSelected'` / `case 'sbInspectState'` branches (or extending existing ones) in two webview message switches — same logic as `design.js:3499-3565`.
- Adding `composeHtmlTweakPrompt()` / `composePlanningHtmlTweakPrompt()` functions — clone of `composeStitchTweakPrompt()` (`design.js:4587-4609`).
- Adding `case 'sendHtmlTweakPrompt'` / `case 'copyHtmlTweakPrompt'` to `PlanningPanelProvider`'s message switch — clone of `DesignPanelProvider.ts:2210-2229`.
- Wiring toggle/close/send/copy click handlers in two webview JS files — clone of `design.js:4568-4656`.
- Injecting `_INSPECTOR_SCRIPT` into the Planning panel srcdoc path — one line wrapping `this._injectLocalCsp(...)`.

### Complex / Risky
- Making `DesignPanelProvider._INSPECTOR_SCRIPT` (and the `_injectIntoHead` helper) accessible to `PlanningPanelProvider`. Verified: `DesignPanelProvider` does **not** import `PlanningPanelProvider` and `PlanningPanelProvider` does **not** import `DesignPanelProvider` today, so adding a one-way import (`PlanningPanelProvider` → `DesignPanelProvider`) creates no cycle. The fallback (extract to `src/services/inspectorScript.ts`) is available if a transitive cycle appears at build time.
- Injecting the inspector into the Planning panel **server** path — requires inserting HTML-rewriting logic inside the `fs_node.readFile` callback (`PlanningPanelProvider.ts:1957-1967`) where `data` and `mimeType` are in scope. Must only rewrite `text/html` responses; binary/image/CSS/JS assets must pass through byte-identical.
- Fixing the Planning panel server deny-list bug (`:1948-1955`) in the same change — switching from absolute-path component matching to `path.relative(normalizedSource, normalizedResolved).split(path.sep)` component matching. Pre-existing latent bug; the fix is low-risk but touches a security-relevant path-traversal guard, so it must be verified against the Design panel's fixed version (`:1690-1701`).
- The shared `stitchElementSelected` message type is `stitch`-prefixed but is now consumed by non-stitch tabs. The `design.js:3124` filter passes these through (no `workspaceRoot` field), but the handler extension must correctly gate on `state.activeSource` so a Stitch-tab selection never populates an HTML-Previews-tab popup and vice versa.

## Edge-Case & Dependency Audit

**Race Conditions**
- Auto-refresh (`isAutoRefreshed`) re-sends `previewReady` while a tweak popup is open. The `previewReady` branch for each tab must reset the inspect toggle, hide the popup, and clear `state.htmlSelectedElement` — while **preserving** the textarea draft (same rule as Stitch HTML, `design.js:1420+`).
- Switching files mid-selection fires a new `previewReady` for the same `sourceId`; the popup must close and the toggle reset even if the new file is also HTML.
- Two tabs sharing the `stitchElementSelected` handler in `design.js`: the handler must early-break when `state.activeSource` does not match the iframe source. The existing guard (`state.activeSource !== 'stitch-html-folder' || event.source !== iframe.contentWindow`) must be extended to an OR of `(stitch-html-folder + stitch frame)` / `(html-folder + html frame)` pairs.

**Security**
- The Planning panel server deny-list fix must not weaken the path-traversal guard (`:1942-1946`). The relative-path component check is **additional** filtering, not a replacement for the `startsWith(normalizedSource + path.sep)` containment check.
- The inspector script runs inside the preview iframe sandbox (`allow-scripts allow-same-origin`). It posts messages to the parent but does not expose filesystem paths beyond the already-present `filePath`. No new attack surface.
- `_INSPECTOR_SCRIPT` is a read-only string constant; making it `public static readonly` changes visibility only — no behavioral risk.

**Side Effects**
- Making `_INSPECTOR_SCRIPT` public exposes a large string constant on the `DesignPanelProvider` class surface. Acceptable for an internal service class; no external consumers.
- The Planning panel server will now rewrite HTML response bodies (string decode → inject → re-encode). Non-HTML responses are untouched. `Cache-Control: no-store` is already set.

**Dependencies & Conflicts**
- `PlanningPanelProvider` will gain a new import of `DesignPanelProvider` (or a shared module). Verified no current import in either direction → no cycle.
- `showTemporaryNotification` is already imported in `PlanningPanelProvider` (`:6`) — no new import needed for the confirmation pattern.
- The `stitchElementSelected` / `sbInspectState` message types are emitted by the shared `_INSPECTOR_SCRIPT`; they are **not** renamed. This is intentional — renaming would require modifying the working Stitch HTML inspector script, increasing blast radius.

## Dependencies

- `feature_plan_20260713060745` — original Stitch HTML Inspect Mode implementation (the reference being generalized). Already complete; this plan consumes its `_INSPECTOR_SCRIPT` and mirrors its UI/handler pattern.

## Adversarial Synthesis

Key risks: (1) the server-path HTML rewrite must stay inside the `readFile` callback and only touch `text/html`; (2) the shared `stitchElementSelected` handler in `design.js` must rigorously gate on `activeSource` + iframe source to prevent cross-tab popup bleed; (3) the workspace-root state field names must match the verified fields (`designWorkspaceRootFilter`, `planningHtmlWorkspaceRootFilter`) — the original plan referenced non-existent fields. Mitigations: mirror the Design panel's `showTemporaryNotification` confirmation pattern exactly, use the verified state field names, and keep the deny-list fix additive to the existing containment guard.

## Proposed Changes

### 1. `src/services/PlanningPanelProvider.ts` — inspector script injection (both render paths)

**Context:** `_buildAndSendPlanningHtmlPreview` (`:1986-2069`) sends `htmlContent: this._injectLocalCsp(fileContent)` (`:2059`) for the srcdoc path. The server path (`_handlePlanningHtmlServerRequest`, `:1928-1974`) serves raw bytes inside the `fs_node.readFile` callback (`:1957-1967`).

**Logic:**

*srcdoc path:* Add a `_injectIntoHead` helper (copy the implementation from `DesignPanelProvider.ts:363-371`) and inject the inspector before CSP stamping:

```ts
htmlContent: isHtmlFile ? this._injectLocalCsp(this._injectIntoHead(fileContent, DesignPanelProvider._INSPECTOR_SCRIPT)) : undefined,
```

This requires accessing `_INSPECTOR_SCRIPT`. Since it's a `private static readonly` on `DesignPanelProvider`, make it `public static readonly` (see change #7). `PlanningPanelProvider` adds `import { DesignPanelProvider } from './DesignPanelProvider';`. Verified: no import exists in either direction today, so this is a one-way dependency — no cycle.

*server path:* Inside the `fs_node.readFile` callback (`:1958-1967`), after computing `mimeType` (`:1964`) and before writing the response, inject the inspector **only for HTML files**. `data` and `mimeType` are both in scope inside the callback:

```ts
fs_node.readFile(resolvedPath, (err: any, data: Buffer) => {
    if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('Not Found');
        return;
    }
    const mimeType = this._getMimeType(resolvedPath);
    if (mimeType.startsWith('text/html')) {
        const html = this._injectIntoHead(data.toString('utf8'), DesignPanelProvider._INSPECTOR_SCRIPT);
        res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
        res.end(Buffer.from(html, 'utf8'));
    } else {
        res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'no-store' });
        res.end(data);
    }
});
```

> **Superseded:** The original plan's server-path snippet referenced `mimeType` and `data` outside the callback context, implying the injection could be placed after reading the file but before writing the response as a flat block.
> **Reason:** In the actual code, `mimeType` is computed at `:1964` and `data` is the callback parameter — both exist only inside the `fs_node.readFile` callback. Placing the injection outside the callback would reference out-of-scope variables.
> **Replaced with:** The injection logic placed inside the `readFile` callback, after `mimeType` is computed, with an explicit `text/html` guard so non-HTML assets pass through byte-identical.

**Edge Cases:** The Planning panel's server deny list (`:1948-1955`) checks absolute path components, not relative-to-source-folder components. This is a pre-existing bug (same class as the one fixed in `DesignPanelProvider` at `:1690-1701`). Fix it in the same change for safety: switch to `path.relative(normalizedSource, normalizedResolved).split(path.sep)` and check those parts instead. **Keep the existing containment guard** (`:1942-1946`) — the relative-path check is additional, not a replacement.

### 2. `src/services/PlanningPanelProvider.ts` — prompt delivery message cases

**Context:** Mirror of `DesignPanelProvider`'s `sendStitchTweakPrompt`/`copyStitchTweakPrompt` (`:2210-2229`). PlanningPanelProvider already has `_taskViewerProvider` (`:197`) with `sendPromptToAgentTerminal` (used at `:3506-3507` for artifact prompts) and already imports `showTemporaryNotification` (`:6`).

**Implementation:**

> **Superseded:** The original plan's `copyHtmlTweakPrompt`/`sendHtmlTweakPrompt` used `this._pushTo(this._panel, 'planning', { type: 'tweakPromptCopied' })` / `{ type: 'tweakPromptSent' }` to confirm the action back to the webview.
> **Reason:** The established Design panel pattern (`copyStitchTweakPrompt`/`sendStitchTweakPrompt` at `DesignPanelProvider.ts:2210-2229`) uses `showTemporaryNotification(...)` for confirmation and does **not** post any message back to the webview. The plan's `_pushTo` approach introduces new message types (`tweakPromptCopied`/`tweakPromptSent`) that the webview sections (#4, #6) never handle — leaving the confirmation dead. `showTemporaryNotification` is already imported in `PlanningPanelProvider`.
> **Replaced with:** Mirror the Design panel exactly — use `showTemporaryNotification(...)` and drop the `_pushTo` calls.

```ts
case 'copyHtmlTweakPrompt': {
    const prompt = String(message.prompt || '');
    if (!prompt) break;
    await vscode.env.clipboard.writeText(prompt);
    showTemporaryNotification('Copied element tweak prompt to clipboard.');
    break;
}

case 'sendHtmlTweakPrompt': {
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

**Edge Cases:** None beyond the existing pattern. The `'coder'` role matches the Design panel's `sendStitchTweakPrompt` (`DesignPanelProvider.ts:2222`).

### 3. `src/webview/design.html` — Inspect Mode button + tweak popup for HTML Previews tab

**Context:** Controls strip `#controls-strip-html` (`:3893-3901`); preview wrapper `#html-preview-wrapper` (`:3922`); iframe `#html-preview-frame` (`:3924`).

**Logic:**
- Add `<button id="html-btn-inspect" class="preview-overlay-btn" title="Toggle hover-to-select element mode">Inspect Mode</button>` to `#controls-strip-html` (after the search input at `:3897`, before the status span at `:3898` — same position as the Stitch HTML tab's button at `:3808`).
- Add a tweak popup as a child of `#html-preview-wrapper` (sibling of `.zoomable-viewport`, before `.zoom-event-layer`), identical structure to `#stitch-tweak-popup` (`:3860-3877`) but with `html-` prefixed IDs: `#html-tweak-popup`, `#html-tweak-header-breadcrumb`, `#html-tweak-btn-close`, `#html-tweak-snippet-pre`, `#html-tweak-input`, `#html-tweak-status`, `#html-tweak-btn-send`, `#html-tweak-btn-copy`.

**Edge Cases:** Popup width capped ~340px with `max-height` + internal scroll, same as Stitch HTML tab (`:3860`).

### 4. `src/webview/design.js` — toggle wiring, selection handling, prompt composition for HTML Previews tab

**Context:** `html-folder` `previewReady` branch (`:1358-1419`), main message switch (`:3119+`), `stitchElementSelected` handler (`:3499-3548`), `sbInspectState` handler (`:3551-3565`), edit-bar wiring region (`:4568+`).

**Logic:**

*State fields:* Add `htmlActiveFilePath: null` and `htmlSelectedElement: null` to `state` (neither exists today — verified). In the `html-folder` `previewReady` branch (`:1358`), after the existing render logic, store `state.htmlActiveFilePath = msg.filePath || null;` and reset: remove `.active` from `#html-btn-inspect`, hide `#html-tweak-popup`, clear `state.htmlSelectedElement`. Preserve the textarea draft (same rule as Stitch HTML — do not clear `#html-tweak-input` on auto-refresh).

*Toggle:* `#html-btn-inspect` click posts `sbInspectToggle` into `#html-preview-frame`'s `contentWindow` (mirror `design.js:4568-4577`).

*Message cases:*
- `stitchElementSelected`: extend the existing handler (`:3499`) so that **in addition to** the `stitch-html-folder` / `#stitch-html-preview-frame` pair, it accepts the `html-folder` / `#html-preview-frame` pair. When `state.activeSource === 'html-folder'` and `event.source` matches `#html-preview-frame`'s `contentWindow`, store as `state.htmlSelectedElement`, render into `#html-tweak-popup` elements (`#html-tweak-header-breadcrumb`, `#html-tweak-snippet-pre`), show popup, focus `#html-tweak-input`. Keep the existing `stitch-html-folder` branch untouched.
- `sbInspectState`: extend the existing handler (`:3551`) so that when `state.activeSource === 'html-folder'` and `event.source` matches `#html-preview-frame`, toggle `#html-btn-inspect`'s `.active` class. Keep the existing `stitch-html-folder` branch untouched.

*Prompt composition:* `composeHtmlTweakPrompt()` — same structure as `composeStitchTweakPrompt()` (`:4587-4609`) but using `state.htmlSelectedElement` and `state.htmlActiveFilePath`.

> **Superseded:** The original plan said `composeHtmlTweakPrompt()` uses "same structure" as `composeStitchTweakPrompt()` without specifying the opening wording.
> **Reason:** `composeStitchTweakPrompt()` opens with "Tweak a generated Stitch screen file in place." (`design.js:4594`). The HTML Previews tab previews arbitrary HTML files, not Stitch screens — reusing that line verbatim would mislead the agent.
> **Replaced with:** Generalize the opening line to "Tweak an HTML file in place." Keep the rest of the structure (File path, selector, outerHTML block, requested change, the serialization caveat at `:4605`, and the "do not create a plan file" closing at `:4607`) identical.

*Actions:*

> **Superseded:** `#html-tweak-btn-send` → `vscode.postMessage({ type: 'sendHtmlTweakPrompt', prompt, workspaceRoot: state.designWorkspaceRoot })`.
> **Reason:** There is no `state.designWorkspaceRoot` field. The verified field is `state.designWorkspaceRootFilter` (`design.js:32`, used at `:3036`, `:3397`, `:4206`, `:5200`).
> **Replaced with:** `#html-tweak-btn-send` → `vscode.postMessage({ type: 'sendHtmlTweakPrompt', prompt, workspaceRoot: state.designWorkspaceRootFilter })`. `#html-tweak-btn-copy` → `{ type: 'copyHtmlTweakPrompt', prompt }` (unchanged — copy carries no workspaceRoot, matching `design.js:4652-4655`).

*Close:* `#html-tweak-btn-close` hides `#html-tweak-popup`, clears `#html-tweak-input`, clears `state.htmlSelectedElement` (mirror `design.js:4579-4585`).

**Edge Cases:** The `stitch*` workspaceRoot filter at `design.js:3124` does not affect these messages — `stitchElementSelected` and `sbInspectState` carry no `workspaceRoot` field, so they pass through untouched (same as the Stitch HTML tab). The handler's `activeSource` + `event.source` gate prevents cross-tab popup bleed.

### 5. `src/webview/planning.html` — Inspect Mode button + tweak popup for HTML tab

**Context:** Controls strip `#controls-strip-planning-html` (`:3641-3648`); preview wrapper `#planning-html-preview-wrapper` (`:3670`); iframe `#planning-html-frame` (`:3672`).

**Logic:**
- Add `<button id="planning-html-btn-inspect" class="preview-overlay-btn" title="Toggle hover-to-select element mode">Inspect Mode</button>` to `#controls-strip-planning-html` (after the search input at `:3645`, before the status span at `:3646`).
- Add a tweak popup as a child of `#planning-html-preview-wrapper` (sibling of `.zoomable-viewport`, before `.zoom-event-layer`), identical structure with `planning-html-` prefixed IDs: `#planning-html-tweak-popup`, `#planning-html-tweak-header-breadcrumb`, `#planning-html-tweak-btn-close`, `#planning-html-tweak-snippet-pre`, `#planning-html-tweak-input`, `#planning-html-tweak-status`, `#planning-html-tweak-btn-send`, `#planning-html-tweak-btn-copy`.

**Edge Cases:** Same popup sizing as Stitch HTML tab.

### 6. `src/webview/planning.js` — toggle wiring, selection handling, prompt composition for HTML tab

**Context:** `planning-html-folder` `previewReady` branch (`:3529-3568`), main message switch (`:4334+`).

**Logic:**

*State fields:* Add `htmlActiveFilePath: null` and `htmlSelectedElement: null` to `state` (neither exists today — verified). In the `planning-html-folder` `previewReady` branch (`:3533`), after the existing render logic and before the `return` at `:3568`, store `state.htmlActiveFilePath = msg.filePath || null;` and reset: remove `.active` from `#planning-html-btn-inspect`, hide `#planning-html-tweak-popup`, clear `state.htmlSelectedElement`. Preserve the textarea draft.

*Toggle:* `#planning-html-btn-inspect` click posts `sbInspectToggle` into `#planning-html-frame`'s `contentWindow`.

*Message cases (new, added to the main message switch at `:4334`):*
- `stitchElementSelected`: check `state.activeSource === 'planning-html-folder'` and `event.source` matches `#planning-html-frame`'s `contentWindow`. Store as `state.htmlSelectedElement`, render into popup elements, show popup, focus textarea.
- `sbInspectState`: same source check; toggle `#planning-html-btn-inspect`'s `.active` class.

*Prompt composition:* `composePlanningHtmlTweakPrompt()` — same structure as `composeStitchTweakPrompt()` but using `state.htmlSelectedElement` and `state.htmlActiveFilePath`. Opening line: "Tweak an HTML file in place." (same generalization as change #4 — not a Stitch screen).

*Actions:*

> **Superseded:** `#planning-html-tweak-btn-send` → `vscode.postMessage({ type: 'sendHtmlTweakPrompt', prompt, workspaceRoot: state.workspaceRoot })`.
> **Reason:** There is no `state.workspaceRoot` field in `planning.js`. The verified field for the planning HTML tab is `state.planningHtmlWorkspaceRootFilter` (`planning.js:2005`).
> **Replaced with:** `#planning-html-tweak-btn-send` → `vscode.postMessage({ type: 'sendHtmlTweakPrompt', prompt, workspaceRoot: state.planningHtmlWorkspaceRootFilter })`. `#planning-html-tweak-btn-copy` → `{ type: 'copyHtmlTweakPrompt', prompt }` (unchanged).

*Close:* `#planning-html-tweak-btn-close` hides `#planning-html-tweak-popup`, clears `#planning-html-tweak-input`, clears `state.htmlSelectedElement`.

**Edge Cases:** No `stitch*` workspaceRoot filter in `planning.js` (the listener at `:4334` only filters `ticketsMsgTypes` at `:4338-4347`), so iframe messages pass through with no special handling.

### 7. `src/services/DesignPanelProvider.ts` — make `_INSPECTOR_SCRIPT` accessible

**Logic:** Change `private static readonly _INSPECTOR_SCRIPT` (`:126`) to `public static readonly _INSPECTOR_SCRIPT`. This is a read-only string constant — no behavioral risk. `PlanningPanelProvider` imports `DesignPanelProvider` (one-way; verified no cycle).

**Edge Cases:** If a transitive circular import appears at build time (e.g. a shared dependency imports both providers), extract `_INSPECTOR_SCRIPT` and `_injectIntoHead` to a small shared utility module (e.g. `src/services/inspectorScript.ts`) and import it from both providers. This is the fallback, not the primary path — the direct visibility change is sufficient given the verified import graph.

## Verification Plan

### Automated Tests
- None required for this pass (per session directive: skip automated tests and compilation). The change is UI/handler duplication following an established, working pattern.

### Manual Verification
1. **Design panel → HTML Previews tab:** Open an HTML file → Inspect Mode button visible in controls strip → toggle → hover highlights elements → click → tweak popup appears → type instruction → Copy Prompt puts full prompt on clipboard (notification shown) → Send to Agent delivers to coder terminal (notification shown).
2. **Planning panel → HTML tab:** Same flow as above.
3. **Stitch HTML tab:** Existing feature still works (no regression from making `_INSPECTOR_SCRIPT` public).
4. Escape exits inspect mode in both new tabs.
5. Auto-refresh (save file externally) clears selection/popup but preserves textarea draft in both tabs.
6. Switch files mid-selection → popup closes, toggle resets in both tabs.
7. With inspect off, HTML pages behave normally (links work, no highlight).
8. **Cross-tab isolation:** With a Stitch HTML screen and a Design HTML Previews file both loaded (different tabs), activating inspect in one tab does not populate the other tab's popup.
9. **Server-path injection:** Planning HTML tab served via the localhost server path (`iframeSrc`) — confirm inspect mode works there too, not just the srcdoc path.
10. **Non-HTML assets:** In the Planning server path, confirm CSS/JS/image assets load byte-identical (no inspector injection, no body rewrite).

## Recommendation

**Send to Coder** (complexity 4). The inspector script and injection rails already exist in `DesignPanelProvider` — the Design panel HTML tab only needs UI + handlers. The Planning panel needs injection (both paths) + UI + handlers, but all patterns are established. The main risks — the `_INSPECTOR_SCRIPT` visibility change, the server-path HTML rewrite placement, and the cross-tab `activeSource` gating — are all well-scoped and verified against the actual code.

## Completion Report

Generalized Stitch HTML Inspect Mode to both the Design panel HTML Previews tab and the Planning panel HTML tab. Files changed: `src/services/DesignPanelProvider.ts` (made `_INSPECTOR_SCRIPT` `public static readonly`; added `copyHtmlTweakPrompt`/`sendHtmlTweakPrompt` provider cases so the Design HTML tab's buttons route to the coder terminal — the plan only specified these cases for PlanningPanelProvider, but design.js sends the same message types to DesignPanelProvider, so adding them here was required to avoid dead buttons), `src/services/PlanningPanelProvider.ts` (added `DesignPanelProvider` import + `_injectIntoHead` helper; injected the inspector into both the srcdoc path and the localhost server path with a `text/html`-only guard; fixed the pre-existing deny-list bug by switching to `path.relative` component matching mirroring DesignPanelProvider; added `copyHtmlTweakPrompt`/`sendHtmlTweakPrompt` cases using `showTemporaryNotification`), `src/webview/design.html` (added `#html-btn-inspect` to `#controls-strip-html` + `#html-tweak-popup` to `#html-preview-wrapper`), `src/webview/design.js` (added `htmlActiveFilePath`/`htmlSelectedElement` state; reset on `html-folder` previewReady; extended the shared `stitchElementSelected`/`sbInspectState` handlers to route on `activeSource` + `event.source` so the html-folder pair populates the html popup; added `composeHtmlTweakPrompt` + toggle/close/send/copy wiring using `state.designWorkspaceRootFilter`), `src/webview/planning.html` (added `preview-overlay-btn`/`stitch-input` CSS blocks; added `#planning-html-btn-inspect` + `#planning-html-tweak-popup`), `src/webview/planning.js` (added state fields; reset on `planning-html-folder` previewReady; added new `stitchElementSelected`/`sbInspectState` cases gated on `planning-html-folder` + `#planning-html-frame`; added `composePlanningHtmlTweakPrompt` + toggle/close/send/copy wiring using `state.planningHtmlWorkspaceRootFilter`). No issues encountered beyond the DesignPanelProvider case gap noted above, which was resolved by mirroring the established stitch pattern. Per session directives, compilation and automated tests were skipped; verification was by read-back + red-team review of all six files.
