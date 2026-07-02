# Add Animated Visual Feedback to All setup.html Buttons

**Plan ID:** f77dc0d9-e6a7-4f11-a9dc-7193c21067da

## Goal

Every action button in `setup.html` either gives **zero** animated feedback on click, or only a static text swap that is easy to miss. The most visible offenders are **APPLY CLICKUP SETTINGS** and **APPLY LINEAR SETTINGS** (the buttons the user explicitly flagged), but the audit below shows the problem is codebase-wide in this file. When a button is clicked there is no spinner, no press animation, no progress indicator — the button just greys out (`disabled = true`) and the user has no idea anything is happening until a result message eventually appears seconds later.

This plan adds a lightweight, reusable busy/spinner state to every actionable button in `setup.html` so clicks always produce immediate, visible animated feedback.

### Problem Analysis & Root Cause

`setup.html` defines two button classes — `.action-btn` (lines 206–212) and `.secondary-btn` (lines 192–204) — plus a few one-off styled buttons (`.db-action-btn`, `.setup-mode-btn`). The only "busy" affordance that exists is `setApplyButtonBusy(kind, busy)` (line 2522), which does nothing more than:

```js
function setApplyButtonBusy(kind, busy) {
    const buttonId = kind === 'clickup' ? 'btn-apply-clickup-config' : ...;
    const button = document.getElementById(buttonId);
    if (button) { button.disabled = !!busy; }
}
```

So "busy" = **disabled + nothing else**. There is no `@keyframes spin` rule, no spinner element, no `.is-busy` class, no press/active animation anywhere in the file (confirmed: grep for `spin|spinner|@keyframes|loading|is-busy|\.busy` returns zero matches). The CSS does define `transition: all 0.2s ease` on the button classes, but that only smooths hover/disabled color changes — there is no click-feedback animation.

There are also two **existing** busy abstractions the original audit missed:

- **`setControlPlaneBusy(busy)`** (lines 1874–1893) — handles all 8 control-plane buttons (`btn-detect-control-plane`, `btn-set-control-plane-root`, `btn-reset-control-plane-root`, `btn-clear-control-plane-cache`, `btn-preview-control-plane`, `btn-execute-control-plane`, `btn-fresh-control-plane`, `btn-scaffold-multi-repo`). It disables/enables buttons and toggles a status div, but includes **no spinner animation**.
- **`setMultiRepoBusy(busy)`** — handles `btn-scaffold-multi-repo`. **⚠️ Pre-existing bug:** this function references an undefined variable `multiRepoScaffoldButton`, so it silently fails to set the button's disabled state. This plan should fix it.

Additionally, the triage buttons (`btn-enable-triage-clickup` / `btn-enable-triage-linear`, lines 3454–3471) **do** have a manual busy state — they set `btn.disabled = true` and `btn.textContent = 'ENABLING…'` — but it's hand-rolled per handler, not reusable, and includes no spinner. The original audit incorrectly stated they "only set a sibling div's text."

Many buttons still have **no busy state at all**: `btn-initialize` (the primary setup button), `btn-apply-notion-config`, `btn-save-prompt-overrides`, `btn-clickup-save-mappings`, `btn-linear-save-automation`, `btn-clickup-save-automation`, `btn-save-mappings` (workspace mappings), `plan-scanner-save`, `linear-browse-include-projects`, `linear-browse-exclude-projects`, and the dynamically-created Notion buttons (`.notion-backup-btn`, `.notion-restore-btn`, `.notion-auto-setup-btn`). These fire a `postMessage` and rely entirely on a result message landing in a status div.

Root cause: there is no shared "button busy" abstraction in `setup.html`. Each handler rolls its own (or none), and none include animation. The existing `setControlPlaneBusy` and `setMultiRepoBusy` are step in the right direction but are narrow in scope and lack visual feedback.

## Metadata

- **Tags:** `ui`, `setup`, `bugfix`, `animation`
- **Complexity:** 4/10
- **Files touched:** `src/webview/setup.html` (1 file — CSS + JS in the same webview document)
- **Shipped-state impact:** Visual-only enhancement to a released webview. No data, no migration, no message-protocol changes. Button `id`s and posted message types are untouched. Fixes one pre-existing bug (`setMultiRepoBusy` undefined variable).

## User Review Required

No review gate required. This is a cosmetic/UX improvement with no logic, data, or API surface impact.

## Complexity Audit

### Routine
- Add a `@keyframes sb-spin` rule + a `.sb-btn-spinner` element style + an `.is-busy` class to the `<style>` block (≈15 lines of CSS, mirrors the pattern already used in `project.html:9–12` which has `@keyframes spin`).
- Add a generic `setButtonBusy(buttonEl, busy, busyLabel?)` helper in the `<script>` block that toggles the `.is-busy` class, injects/removes a spinner `<span>`, and disables/enables the button. Replaces the narrow `setApplyButtonBusy` (which only handles 3 buttons by kind).
- Wire the new helper into every existing click handler that currently posts a message and awaits a result. For handlers that already call `setApplyButtonBusy`, swap the call to `setButtonBusy`. For handlers with no busy state, add the call.
- Add a CSS `:active` press animation (scale 0.97) to `.action-btn` and `.secondary-btn` so **every** click — even instant ones — has tactile feedback.
- Enhance `setControlPlaneBusy()` and `setMultiRepoBusy()` to delegate to `setButtonBusy` instead of reinventing busy logic.
- Fix `setMultiRepoBusy` pre-existing bug (undefined `multiRepoScaffoldButton` variable).

### Complex / Risky
- **Notion dynamic buttons:** `.notion-backup-btn`, `.notion-restore-btn`, `.notion-auto-setup-btn` are created dynamically via event delegation (lines 3697–3727), not static HTML. The `setButtonBusy` helper takes a `buttonEl` so it works with dynamic buttons, but the busy clear calls must be added to the corresponding message handler cases (`backupToNotionResult`, `restoreFromNotionResult`, `autoCreateNotionDatabaseResult`). **⚠️ Pre-existing bug:** the message handlers at lines 4832–4848 try to disable these buttons by ID (`notion-backup-btn` etc.), but the buttons use class names, not IDs. These `getElementById` calls silently fail. This plan should fix them to use `querySelector` with the class.
- **`btn-apply-linear-config` uses a different status mechanism:** the Linear apply handler (line 3491) calls `setIntegrationStatus('linear', 'working')`, not `setApplyButtonBusy`. The wrapper replacement must account for this — either route through `setButtonBusy` directly or update `setIntegrationStatus` to delegate.
- **`btn-apply-notion-config` has no busy state at all:** the Notion apply handler (line 3573) doesn't call any busy function. Add `setButtonBusy` call.

## Edge-Case & Dependency Audit

- **Race Conditions:** No race conditions. Button busy state is synchronous DOM manipulation. Result handlers clear busy state in the same single-threaded message loop.
- **Security:** No security implications. Pure UI enhancement.
- **Side Effects:** Fixing the `setMultiRepoBusy` undefined variable bug will make the scaffold button actually disable during multi-repo scaffolding — a behaviour change (currently it stays interactive because the disable call silently fails). This is a bug fix, not a regression.
- **Dependencies & Conflicts:** No dependencies on other plans. The `:active` press animation uses `transform: scale(0.97)` — no existing code sets `transform` on `.action-btn` or `.secondary-btn`, so no conflict. The `transition: all 0.2s ease` on these classes will smoothly animate the scale on release (desired bounce effect).
- **Buttons that are instant (no async result):** e.g. `btn-copy-tutorial-prompt`, `btn-open-docs`, `btn-add-mapping`, `btn-clickup-add-rule`, `btn-linear-add-rule`. These don't await a result message, so a busy spinner would never get cleared by a result handler. **Mitigation:** for instant/local actions, use only the `:active` press animation (no spinner). Reserve the spinner/busy state for buttons that post a message and wait for a `*Result` message to clear it. The `setButtonBusy` helper must be paired with a clearing call in the corresponding `case` in the message handler.
- **Buttons with no result message at all:** `btn-browse-clickup-ticket-folder` / `btn-browse-linear-ticket-folder` post `browseTicketsFolder` — the result comes back as a separate `ticketsFolderSelected` message that sets the input value, not a per-button result. **Mitigation:** rely on the `:active` press animation only (no spinner).
- **Triage buttons:** these DO have a result (`triagePipelineResult` at line 4779), so they get the full spinner treatment. They already have manual busy state (`btn.disabled = true; btn.textContent = 'ENABLING…'`) — replace with `setButtonBusy` call. The clearing call goes in the existing `case 'triagePipelineResult'` block (replace the manual `btn.disabled = false; btn.textContent = '⚡ ENABLE TRIAGE PIPELINE'` with `setButtonBusy(btn, false)`).
- **`setApplyButtonBusy` callers:** there is a second call site (initialization/reset path) that sets busy to `false`. Ensure the new helper handles the `false` path identically (re-enable, remove spinner, restore label).
- **Disabled-gating logic:** `updateApplyButtonsState()` (line 3520) sets `btn.disabled = !token` for ClickUp and Linear apply buttons. **Note:** it does NOT gate the Notion apply button. The busy helper must not fight this — when clearing busy, only re-enable if the token gate also passes. Simplest fix: after clearing busy, call `updateApplyButtonsState()` for clickup/linear apply buttons instead of unconditionally enabling. For the Notion apply button (not gated by `updateApplyButtonsState`), unconditional re-enable is fine.
- **Theme variants (cyber / claudify):** the spinner should use `var(--accent-teal)` (defined at line 26, overridden to `#D97757` for claudify at line 39) so it inherits the correct accent in both themes. Using `currentColor` in the spinner border achieves this since `.action-btn` already uses `color-mix(in srgb, var(--accent-teal) 80%, var(--text-secondary))`. No theme-specific overrides needed.

## Dependencies

None. This plan is self-contained within `setup.html`. It does not depend on the pixel-font/ultracode toggle plan, though both plans modify `setup.html` and should be implemented sequentially to avoid merge conflicts.

## Proposed Changes

### File: `src/webview/setup.html`

#### 1. Add spinner + press-animation CSS (in the first `<style>` block, after the `.action-btn:hover` rule at line 218)

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

#### 2. Add a generic `setButtonBusy` helper (in the `<script>` block, replacing/augmenting `setApplyButtonBusy` at line 2522)

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

#### 3. Enhance existing `setControlPlaneBusy()` (line 1874) to delegate to `setButtonBusy`

Instead of manually disabling/enabling each button, have `setControlPlaneBusy` call `setButtonBusy` for each control-plane button. This adds the spinner to all 8 control-plane buttons without duplicating logic. Keep the status div toggling that `setControlPlaneBusy` already does.

#### 4. Fix and enhance `setMultiRepoBusy()` 

**⚠️ Pre-existing bug:** `setMultiRepoBusy` references undefined `multiRepoScaffoldButton`. Fix by resolving the element with `document.getElementById('btn-scaffold-multi-repo')` inside the function, then delegate to `setButtonBusy`.

#### 5. Wire busy state into handlers that currently lack it

**Triage buttons** (lines 3454–3471) — replace the manual `btn.disabled = true; btn.textContent = 'ENABLING…'` with:

```js
// click handler:
const triageBtn = document.getElementById('btn-enable-triage-clickup');
setButtonBusy(triageBtn, true, 'ENABLING…');
vscode.postMessage({ type: 'enableTriagePipeline', provider: 'clickup', token });
// (repeat for linear with btn-enable-triage-linear)
```

In the `case 'triagePipelineResult'` block (line 4779), replace the manual `btn.disabled = false; btn.textContent = '⚡ ENABLE TRIAGE PIPELINE'` with:
```js
setButtonBusy(document.getElementById(message.provider === 'linear' ? 'btn-enable-triage-linear' : 'btn-enable-triage-clickup'), false);
```

**Apply buttons:**
- `btn-apply-clickup-config` (line 3440) — already calls `setApplyButtonBusy('clickup', true)`. The wrapper now delegates to `setButtonBusy`, so no handler change needed.
- `btn-apply-linear-config` (line 3491) — currently calls `setIntegrationStatus('linear', 'working')`, NOT `setApplyButtonBusy`. Add `setApplyButtonBusy('linear', true)` alongside the existing status call, or replace the status call with the busy helper if `setIntegrationStatus` is redundant. Clear in the result handler.
- `btn-apply-notion-config` (line 3573) — has NO busy state. Add `setApplyButtonBusy('notion', true)` in the click handler and clear in the result handler.

**Save mappings / save automation buttons** — these post a message and get a `*Saved` result. Add `setButtonBusy(btn, true, 'SAVING…')` in the click handler and `setButtonBusy(btn, false)` in the corresponding result `case`:
- `btn-clickup-save-mappings` (line 3472) → `saveClickUpMappings` / result case
- `btn-clickup-save-automation` (line 3484) → `saveClickUpAutomation` / result case
- `btn-linear-save-automation` (line 3507) → `saveLinearAutomation` / result case
- `btn-save-mappings` (workspace mappings, line 4006) → `saveWorkspaceMappings` / result case
- `plan-scanner-save` (line 4162) → `setPlanScannerConfig` / result case

**`btn-initialize`** (line 3235) — posts `runSetup` and awaits a result. Add `setButtonBusy(btn, true, 'INITIALIZING…')` and clear in the result handler.

**`btn-save-prompt-overrides`** (line 3371) — add `setButtonBusy(btn, true, 'SAVING…')`. Clear in the result handler (or on modal close, which already happens).

**Notion dynamic buttons** (lines 3697–3727) — created via event delegation with class names (`.notion-backup-btn`, `.notion-restore-btn`, `.notion-auto-setup-btn`). In the event delegation handlers, call `setButtonBusy(clickedBtn, true, 'WORKING…')`. In the result message handlers (`backupToNotionResult`, `restoreFromNotionResult`, `autoCreateNotionDatabaseResult`), clear via `setButtonBusy`. **⚠️ Fix pre-existing bug:** the result handlers at lines 4832–4848 try `document.getElementById('notion-backup-btn')` but the buttons use classes. Change to `document.querySelector('.notion-backup-btn')` or track the active button reference.

**`linear-browse-include-projects` / `linear-browse-exclude-projects`** (lines 3514–3518) — post `linearBrowseProjects`. These open a picker dialog. Add a short auto-clearing busy state or rely on `:active` press animation only. Prefer the latter for simplicity.

**Export/Import settings** (`btn-export-prompts`, `btn-import-prompts`, lines 3237–3253) — these trigger file dialogs; rely on the `:active` press animation only (no spinner). They already set a status div text.

#### 6. Buttons that need NO spinner (instant/local actions)

These get only the `:active` press animation from the CSS — no JS changes:
- `btn-copy-tutorial-prompt`, `btn-open-docs`
- `btn-add-mapping`, `btn-clickup-add-rule`, `btn-linear-add-rule`, `btn-clickup-create-unmapped`
- `btn-browse-clickup-ticket-folder`, `btn-browse-linear-ticket-folder`
- `btn-agent-dir-cleanup`, `btn-agent-dir-cleanup-cancel`, `btn-agent-dir-cleanup-confirm`
- `btn-cancel-*` buttons
- `btn-clear-prompt-override`
- `setup-mode-btn` toggles
- `linear-browse-include-projects`, `linear-browse-exclude-projects`
- `btn-copy-db-settings` (clipboard operation)
- `memo-open-keybindings`
- Dynamically created `button[data-action="remove"]`, `button[data-action="browseDbPath"]`, `button[data-action="browseParentFolder"]`, `button[data-action="browseFolders"]`, `button[data-action="initDb"]`, `button[data-action="switchToConnect"]`

## Adversarial Synthesis

Key risks: (1) the original audit missed two existing busy abstractions (`setControlPlaneBusy`, `setMultiRepoBusy`) — the plan must enhance these rather than reinvent, or duplicate busy logic will fight them; (2) `setMultiRepoBusy` has a pre-existing bug (undefined variable) that must be fixed as part of the enhancement; (3) Notion buttons are dynamically created with class names, not IDs — the `setButtonBusy` helper works with any element reference, but the result handlers have a pre-existing bug trying to resolve them by ID; (4) `btn-apply-linear-config` uses a different status mechanism (`setIntegrationStatus`) that must be reconciled with the new wrapper. Mitigations: enhance existing functions to delegate to `setButtonBusy`, fix both pre-existing bugs, and explicitly call out the Linear apply button's unique status path.

## Verification Plan

### Automated Tests
No automated tests required. This is a visual/UX enhancement confined to a single webview document's inline CSS/JS. The existing test suite (run separately by the user) should be consulted for regressions in message handling, but no new test files are needed.

### Manual Verification
1. **Compile check:** `npm run compile` — confirms no syntax errors in the bundled webview. **Skip compilation for this session** — the project is in a pre-compiled state.
2. **Manual test (installed VSIX):**
   - Open the Setup panel → ClickUp tab. Enter a token. Click **APPLY CLICKUP SETTINGS**. Confirm: button shows a spinner + "APPLYING…" label + greys out. On result, spinner disappears and label restores.
   - Repeat for **APPLY LINEAR SETTINGS** and **APPLY NOTION SETTINGS**.
   - Click **ENABLE TRIAGE PIPELINE** on both ClickUp and Linear tabs. Confirm spinner appears and clears on `triagePipelineResult`.
   - Click **SAVE MAPPINGS** and **SAVE AUTOMATION** on both providers. Confirm spinner + clear.
   - Click **INITIALIZE** (btn-initialize). Confirm spinner + "INITIALIZING…" + clear on result.
   - Click **SAVE PROMPT OVERRIDES**. Confirm spinner + clear.
   - Click any control-plane button (e.g. **DETECT**, **PREVIEW MIGRATION**). Confirm spinner appears (via enhanced `setControlPlaneBusy`).
   - Click **SCAFFOLD MULTI-REPO**. Confirm button actually disables now (the `setMultiRepoBusy` bug fix).
   - Click any Notion backup/restore/auto-setup button. Confirm spinner + clear on result.
   - Click any instant button (e.g. **COPY TUTORIAL PROMPT**, **ADD RULE**). Confirm the `:active` scale press animation fires.
   - Test in both **cyber** (default) and **claudify** themes — spinner should adopt the correct accent color.
3. **Token-gate regression:** clear the ClickUp token field. Confirm the APPLY button stays disabled even after a failed apply (the `updateApplyButtonsState()` call in the clear path re-applies the gate).
4. **No-stuck-busy check:** trigger an apply, then close and reopen the Setup panel. Confirm no button is left in a stuck busy state (fresh panel load should reset all buttons).
5. **Pre-existing bug verification:** confirm `btn-scaffold-multi-repo` now actually disables during scaffolding (was silently failing before). Confirm Notion backup/restore buttons get busy state cleared correctly (was failing due to ID-vs-class mismatch).

## Recommendation
Complexity 4 → **Send to Coder**.
