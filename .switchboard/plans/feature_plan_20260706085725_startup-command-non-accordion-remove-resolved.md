# Fix Startup Command Entry in Comms Tab — Remove "(resolved)" Text and Accordion

## Goal

In the Comms Monitor tab of `kanban.html`, the resolved startup command is displayed inside a collapsible `<details>`/`<summary>` accordion with the label "Startup command (resolved)". The user wants two changes:
1. Remove the "(resolved)" parenthetical from the label — it should just say "Startup command".
2. Remove the accordion behavior — the command box should always be visible, not hidden behind a toggle.

### Problem Analysis & Root Cause

The startup command display is implemented at lines 8952-8963 of `src/webview/kanban.html` using a `<details>` element with a `<summary>` child. The `<details>` element is collapsed by default (no `open` attribute), so the user must click to expand it. The summary text includes "(resolved)" which is unnecessary jargon.

The root cause is simply a design choice that prioritized compactness over visibility. The command is short and important enough to always show.

## Metadata

- **Tags:** ui-cleanup, comms-tab, kanban-html
- **Complexity:** 1

## Complexity Audit

**Routine.** Replace a `<details>`/`<summary>` accordion with a plain div + label. No logic changes, no backend changes.

## Edge-Case & Dependency Audit

- The `mcpMonitorResolvedCmd` variable is still needed — it feeds the command text.
- The `cmdPre` element (the `<pre>` showing the command) should be preserved; only the wrapping accordion is removed.
- No event listeners are attached to the `<details>` or `<summary>` elements.

## Proposed Changes

### `src/webview/kanban.html` — Replace accordion with always-visible box (~lines 8952-8963)

**Before:**
```javascript
// Resolved startup command (collapsible)
const cmdDetails = document.createElement('details');
cmdDetails.style.cssText = 'margin:0 8px 8px 8px; font-size:9px; color:var(--text-secondary);';
const cmdSummary = document.createElement('summary');
cmdSummary.textContent = 'Startup command (resolved)';
cmdSummary.style.cssText = 'cursor:pointer; color:var(--text-secondary);';
const cmdPre = document.createElement('pre');
cmdPre.style.cssText = 'margin-top:4px; padding:4px; background:var(--panel-bg); border:1px solid var(--border-color); border-radius:3px; font-size:9px; color:var(--text-primary); white-space:pre-wrap; word-break:break-all;';
cmdPre.textContent = mcpMonitorResolvedCmd || '(not resolved)';
cmdDetails.appendChild(cmdSummary);
cmdDetails.appendChild(cmdPre);
container.appendChild(cmdDetails);
```

**After:**
```javascript
// Startup command (always visible)
const cmdLabel = document.createElement('div');
cmdLabel.style.cssText = 'margin:0 8px 2px 8px; font-size:9px; color:var(--text-secondary);';
cmdLabel.textContent = 'Startup command';
const cmdPre = document.createElement('pre');
cmdPre.style.cssText = 'margin:0 8px 8px 8px; padding:4px; background:var(--panel-bg); border:1px solid var(--border-color); border-radius:3px; font-size:9px; color:var(--text-primary); white-space:pre-wrap; word-break:break-all;';
cmdPre.textContent = mcpMonitorResolvedCmd || '(not resolved)';
container.appendChild(cmdLabel);
container.appendChild(cmdPre);
```

Key changes:
- `<details>`/`<summary>` replaced with a plain `<div>` label + `<pre>` box.
- Label text changed from "Startup command (resolved)" to "Startup command".
- The `<pre>` is always visible (no toggle).
- Margin adjusted so the label sits directly above the pre block.

## Verification Plan

1. Open the Kanban board and switch to the Comms tab.
2. Verify the startup command box is immediately visible without clicking.
3. Verify the label reads "Startup command" (no "(resolved)" text).
4. Verify the command text displays correctly inside the bordered box.
