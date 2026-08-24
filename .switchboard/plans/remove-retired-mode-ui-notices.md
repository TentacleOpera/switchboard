# Remove Retired-Mode UI Notices

## Goal

The Mission Control panel shows a permanent orange banner reading "The AUTOMATION tab has moved here. Your previous mode selection has been retired." This banner is dead UI that renders unconditionally due to a CSS/HTML conflict: the `.mc-notice` class sets `display: flex`, which overrides the `hidden` attribute on the div. No host code ever sends the `mcRetiredNotice` message that would toggle its visibility — that message type does not exist anywhere in the TypeScript codebase.

The AUTOMATION tab was never released, making the banner text nonsensical to users. The kanban panel has two similar dynamic notice renderings (`retiredAutomationModeNotice` and `recurringJobsResumedNotice`) for the same unreleased migration. All three UI notice surfaces should be removed.

The automation backend (autobanState.ts, TaskViewerProvider.ts) is mid-redesign and must not be touched — only the UI rendering surfaces are removed.

## Metadata

**Complexity:** 2
**Tags:** ui, bugfix, refactor
**Project:** Browser Switchboard

## Problem Analysis

### Root cause

`mission-control.html` line 263:
```html
<div id="mc-retired-notice" class="mc-notice" hidden>
```

`mission-control.html` line 245 (CSS):
```css
.mc-notice { ... display: flex; ... }
```

`display: flex` overrides `hidden` (which sets `display: none`). The div is always visible. The `mcRetiredNotice` message handler in `mission-control.js` (line 529-531) is the only code that could toggle `hidden`, but no host ever sends that message — `mcRetiredNotice` appears in zero `.ts` files.

### Why the notices exist

The `retiredAutomationModeNotice` and `recurringJobsResumedNotice` fields in `autobanState.ts` are migration notices for the transition from a single "AUTOMATION tab" with a mode selector to a two-switch system (schedule + Mission Control). Since the AUTOMATION tab was never released, no shipped install carries the pre-migration state shape, making these notices unreachable by real users. The kanban panel renders them dynamically from the autoban broadcast state (lines 12576-12591).

### What stays

- `autobanState.ts`: `retiredAutomationModeNotice`, `recurringJobsResumedNotice`, `isRetiredMode` guard, `RETIRED_AUTOMATION_MODES` — all untouched (mid-redesign)
- `TaskViewerProvider.ts`: workspaceState latches for both notices — untouched
- `autoban-state-regression.test.js`: test assertions on the backend state fields — untouched

## Implementation

### 1. mission-control.html

**Remove the CSS block** (lines 244-247):
```css
/* ── Retired-mode notice ────────────────────────────────────────── */
.mc-notice { padding: 8px 12px; ... display: flex; ... }
.mc-notice-dismiss { ... }
.mc-notice-dismiss:hover { ... }
```

**Remove the HTML div** (lines 262-266):
```html
<!-- Retired-mode notice (surfaces once when legacy autoban mode state exists) -->
<div id="mc-retired-notice" class="mc-notice" hidden>
    <span>The AUTOMATION tab has moved here. Your previous mode selection has been retired.</span>
    <button class="mc-notice-dismiss" id="mc-notice-dismiss" title="Dismiss">×</button>
</div>
```

### 2. mission-control.js

**Remove the dismiss button handler** (lines 441-447):
```js
/* ── Retired-mode notice ─────────────────────────────────────────── */
const noticeDismiss = document.getElementById('mc-notice-dismiss');
if (noticeDismiss) noticeDismiss.addEventListener('click', () => {
    const notice = document.getElementById('mc-retired-notice');
    if (notice) notice.hidden = true;
    vscode.postMessage({ type: 'mcDismissRetiredNotice' });
});
```

**Remove the message handler case** (lines 529-531):
```js
case 'mcRetiredNotice':
    { const notice = document.getElementById('mc-retired-notice'); if (notice) notice.hidden = !msg.show; }
    break;
```

**Update the init comment** (line 572) — remove `mcRetiredNotice` from the list of expected reply types:
```js
// replies with mcMissions / mcSchedules / mcControllerSeat / mcRetiredNotice.
```
→
```js
// replies with mcMissions / mcSchedules / mcControllerSeat.
```

### 3. kanban.html

**Remove the retiredAutomationModeNotice rendering** (lines 12576-12583):
```js
// One-time notice for a retired automationMode. The schedule
// was forced off — the user must re-arm it explicitly.
if (state.retiredAutomationModeNotice) {
    const notice = document.createElement('div');
    notice.style.cssText = '...';
    notice.textContent = state.retiredAutomationModeNotice;
    automationRulesSectionSc.appendChild(notice);
}
```

**Remove the recurringJobsResumedNotice rendering** (lines 12585-12591):
```js
// One-time notice for recurring jobs resuming on upgrade from external mode.
if (state.recurringJobsResumedNotice) {
    const notice = document.createElement('div');
    notice.style.cssText = '...';
    notice.textContent = state.recurringJobsResumedNotice;
    automationRulesSectionSc.appendChild(notice);
}
```

## Verification Plan

- [ ] Open the Mission Control panel — confirm no orange banner appears at the top
- [ ] Open the Kanban panel's automation section — confirm no retired-mode or recurring-jobs notices render
- [ ] `grep -r "mc-retired-notice\|mcRetiredNotice\|mcDismissRetiredNotice\|mc-notice" src/webview/` returns zero hits in mission-control.html and mission-control.js
- [ ] `grep -r "retiredAutomationModeNotice\|recurringJobsResumedNotice" src/webview/kanban.html` returns zero hits
- [ ] Run existing test suite — `autoban-state-regression.test.js` still passes (backend fields untouched)
