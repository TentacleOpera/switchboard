# Add Animated Visual Feedback to All setup.html Buttons

## Goal

Every action button in `setup.html` either gives **zero** animated feedback on click, or only a static text swap that is easy to miss. The most visible offenders are **APPLY CLICKUP SETTINGS** and **APPLY LINEAR SETTINGS** (the buttons the user explicitly flagged), but the audit below shows the problem is codebase-wide in this file. When a button is clicked there is no spinner, no press animation, no progress indicator — the button just greys out (`disabled = true`) and the user has no idea anything is happening until a result message eventually appears seconds later.

This plan adds a lightweight, reusable busy/spinner state to every actionable button in `setup.html` so clicks always produce immediate, visible animated feedback.

### Problem Analysis & Root Cause

`setup.html` defines two button classes — `.action-btn` and `.secondary-btn` — plus a few one-off styled buttons (`.db-action-btn`, `.setup-mode-btn`). The only "busy" affordance that exists is `setApplyButtonBusy(kind, busy)`, which does nothing more than:

```js
function setApplyButtonBusy(kind, busy) {
    const buttonId = kind === 'clickup' ? 'btn-apply-clickup-config' : ...;
    const button = document.getElementById(buttonId);
    if (button) { button.disabled = !!busy; }
}
```

So "busy" = **disabled + nothing else**. There is no `@keyframes spin` rule, no spinner element, no `.is-busy` class, no press/active animation anywhere in the file (confirmed: grep for `spin|spinner|@keyframes|loading|is-busy|\.busy` returns zero matches). The CSS does define `transition: all 0.2s ease` on the button classes, but that only smooths hover/disabled color changes — there is no click-feedback animation.

Worse, most buttons do not even call `setApplyButtonBusy`. The triage buttons (`btn-enable-triage-clickup` / `btn-enable-triage-linear`) only set a sibling div's text to "Enabling triage pipeline…" — the button itself stays fully interactive and unchanged. The save-mappings, save-automation, add-rule, browse, export/import, control-plane, and prompt-override buttons have **no busy state at all** — they fire a `postMessage` and rely entirely on a result message landing in a status div somewhere else on the page.

Root cause: there is no shared "button busy" abstraction in `setup.html`. Each handler rolls its own (or none), and none include animation.

## Metadata

- **Tags:** `ui`, `setup`, `bugfix`, `animation`
- **Complexity:** 3/10
- **Files touched:** `src/webview/setup.html` (1 file — CSS + JS in the same webview document)
- **Shipped-state impact:** Visual-only enhancement to a released webview. No data, no migration, no message-protocol changes. Button `id`s and posted message types are untouched.

## User Review Required

No review gate required. This is a cosmetic/UX improvement with no logic, data, or API surface impact.

## Complexity Audit

### Routine
- Add a `@keyframes spin` rule + a `.btn-spinner` pseudo-element style + an `.is-busy` class to the `<style>` block (≈15 lines of CSS, mirrors the pattern already used in `project.html` which has `@keyframes spin`).
- Add a generic `setButtonBusy(buttonEl, busy, originalLabel?)` helper in the `<script>` block that toggles the `.is-busy` class, injects/removes a spinner `<span>`, and disables/enables the button. Replaces the narrow `setApplyButtonBusy` (which only handles 3 buttons by kind).
- Wire the new helper into every existing click handler that currently posts a message and awaits a result. For handlers that already call `setApplyButtonBusy`, swap the call to `setButtonBusy`. For handlers with no busy state, add the call.
- Add a CSS `:active` press animation (scale 0.97) to `.action-btn` and `.secondary-btn` so **every** click — even instant ones — has tactile feedback.

### Complex / Risky
- None. All changes are confined to the webview document's inline CSS/JS. No backend, no message protocol, no persistence.

## Edge-Case & Dependency Audit

- **Buttons that are instant (no async result):** e.g. `btn-copy-tutorial-prompt`, `btn-open-docs`, `btn-add-mapping`, `btn-clickup-add-rule`, `btn-linear-add-rule`. These don't await a result message, so a busy spinner would never get cleared by a result handler. **Mitigation:** for instant/local actions, use only the `:active` press animation (no spinner). Reserve the spinner/busy state for buttons that post a message and wait for a `*Result` message to clear it. The `setButtonBusy` helper must be paired with a clearing call in the corresponding `case` in the message handler.
- **Buttons with no result message at all:** `btn-browse-clickup-ticket-folder` / `btn-browse-linear-ticket-folder` post `browseTicketsFolder` — the result comes back as a separate `ticketsFolderSelected` message that sets the input value, not a per-button result. **Mitigation:** add a short auto-clearing busy state (e.g. 800 ms timeout) for browse buttons, or skip the spinner and rely on the `:active` press animation only. Prefer the latter for simplicity.
- **Triage buttons:** these DO have a result (`triagePipelineResult`), so they get the full spinner treatment. The clearing call goes in the existing `case 'triagePipelineResult'` block.
- **`setApplyButtonBusy` callers at line 2959:** there is a second call site (initialization/reset path) that sets busy to `false`. Ensure the new helper handles the `false` path identically (re-enable, remove spinner, restore label).
- **Disabled-gating logic:** `updateApplyButtonsState()` sets `btn.disabled = !token`. The busy helper must not fight this — when clearing busy, only re-enable if the token gate also passes. Simplest fix: after clearing busy, call `updateApplyButtonsState()` for clickup/linear apply buttons instead of unconditionally enabling.
- **Theme variants (cyber / claudify):** the spinner should use `var(--accent-teal)` so it inherits the correct accent in both themes. No theme-specific overrides needed.

## Proposed Changes

### File: `src/webview/setup.html`

#### 1. Add spinner + press-animation CSS (in the first `<style>` block, after the `.action-btn:hover` rule ≈ line 218)

```css
@keyframes sb-spin {
    to { transform: rotate(360deg); }
}
.action-btn.is-busy,
.secondary-btn.is-busy {
    position: relative;
    opacity: 0.65;
    cursor: wait;
}
.action-btn.is-busy .sb-btn-spinner,
.secondary-btn.is-busy .sb-btn-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    margin-right: 6px;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: sb-spin 0.6s linear infinite;
    vertical-align: -2px;
}
.sb-btn-spinner { display: none; }
.action-btn:active:not(:disabled),
.secondary-btn:active:not(:disabled) {
    transform: scale(0.97);
}
```

#### 2. Add a generic `setButtonBusy` helper (in the `<script>` block, replacing/augmenting `setApplyButtonBusy` ≈ line 2522)

```js
function setButtonBusy(buttonEl, busy, busyLabel) {
    if (!buttonEl) return;
    if (busy) {
        if (!buttonEl.querySelector('.sb-btn-spinner')) {
            const spinner = document.createElement('span');
            spinner.className = 'sb-btn-spinner';
            buttonEl.prepend(spinner);
        }
        buttonEl.classList.add('is-busy');
        buttonEl.disabled = true;
        if (busyLabel) { buttonEl.dataset.origLabel = buttonEl.textContent; buttonEl.textContent = busyLabel; }
    } else {
        buttonEl.classList.remove('is-busy');
        const spinner = buttonEl.querySelector('.sb-btn-spinner');
        if (spinner) spinner.remove();
        if (buttonEl.dataset.origLabel) { buttonEl.textContent = buttonEl.dataset.origLabel; delete buttonEl.dataset.origLabel; }
        // Don't blindly re-enable — let the token-gate re-apply for apply buttons
        if (buttonEl.id !== 'btn-apply-clickup-config' && buttonEl.id !== 'btn-apply-linear-config' && buttonEl.id !== 'btn-apply-notion-config') {
            buttonEl.disabled = false;
        }
    }
}
```

Keep `setApplyButtonBusy(kind, busy)` as a thin wrapper that resolves the kind → element and delegates to `setButtonBusy`, then calls `updateApplyButtonsState()` when clearing:

```js
function setApplyButtonBusy(kind, busy) {
    const buttonId = kind === 'clickup' ? 'btn-apply-clickup-config'
        : kind === 'linear' ? 'btn-apply-linear-config'
        : 'btn-apply-notion-config';
    setButtonBusy(document.getElementById(buttonId), busy, busy ? 'APPLYING…' : '');
    if (!busy) updateApplyButtonsState();
}
```

#### 3. Wire busy state into handlers that currently lack it

**Triage buttons** (≈ line 3454 / 3461) — add busy + clear in result handler:

```js
// click handler:
const triageBtn = document.getElementById('btn-enable-triage-clickup');
setButtonBusy(triageBtn, true, 'ENABLING…');
vscode.postMessage({ type: 'enableTriagePipeline', provider: 'clickup', token });
// (repeat for linear with btn-enable-triage-linear)
```

In the `case 'triagePipelineResult'` block (≈ line 4781), add:
```js
setButtonBusy(document.getElementById(message.provider === 'linear' ? 'btn-enable-triage-linear' : 'btn-enable-triage-clickup'), false);
```

**Save mappings / save automation / add rule** buttons — these post a message and get a `*Saved` result. Add `setButtonBusy(btn, true, 'SAVING…')` in the click handler and `setButtonBusy(btn, false)` in the corresponding result `case`.

**Control-plane modal buttons** (`btn-preview-control-plane`, `btn-execute-control-plane`, `btn-fresh-control-plane`, `btn-scaffold-multi-repo`, `btn-set-control-plane-root`, `btn-reset-control-plane-root`, `btn-clear-control-plane-cache`, `btn-detect-control-plane`) — add busy state with auto-clear fallback if no explicit result handler exists.

**Prompt-override buttons** (`btn-save-prompt-overrides`) — add `setButtonBusy(btn, true, 'SAVING…')`.

**Export/Import settings** (`btn-export-prompts`, `btn-import-prompts`) — these are instant file dialogs; rely on the `:active` press animation only (no spinner).

#### 4. Buttons that need NO spinner (instant/local actions)

These get only the `:active` press animation from the CSS — no JS changes:
- `btn-copy-tutorial-prompt`, `btn-open-docs`
- `btn-add-mapping`, `btn-clickup-add-rule`, `btn-linear-add-rule`, `btn-clickup-create-unmapped`
- `btn-browse-clickup-ticket-folder`, `btn-browse-linear-ticket-folder`
- `btn-agent-dir-cleanup`, `btn-agent-dir-cleanup-cancel`, `btn-agent-dir-cleanup-confirm`
- `btn-cancel-*` buttons
- `btn-clear-prompt-override`
- `setup-mode-btn` toggles

## Verification Plan

1. **Compile check:** `npm run compile` — confirms no syntax errors in the bundled webview.
2. **Manual test (installed VSIX):**
   - Open the Setup panel → ClickUp tab. Enter a token. Click **APPLY CLICKUP SETTINGS**. Confirm: button shows a spinner + "APPLYING…" label + greys out. On result, spinner disappears and label restores.
   - Repeat for **APPLY LINEAR SETTINGS** and **APPLY NOTION SETTINGS**.
   - Click **ENABLE TRIAGE PIPELINE** on both ClickUp and Linear tabs. Confirm spinner appears and clears on `triagePipelineResult`.
   - Click **SAVE MAPPINGS** and **SAVE AUTOMATION** on both providers. Confirm spinner + clear.
   - Click any instant button (e.g. **COPY TUTORIAL PROMPT**, **ADD RULE**). Confirm the `:active` scale press animation fires.
   - Test in both **cyber** (default) and **claudify** themes — spinner should adopt the correct accent color.
3. **Token-gate regression:** clear the ClickUp token field. Confirm the APPLY button stays disabled even after a failed apply (the `updateApplyButtonsState()` call in the clear path re-applies the gate).
4. **No-stuck-busy check:** trigger an apply, then close and reopen the Setup panel. Confirm no button is left in a stuck busy state (fresh panel load should reset all buttons).
