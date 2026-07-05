# Remove Haiku Model Callout Box in Comms Tab

## Goal

The Comms Monitor tab in `kanban.html` displays a "Model Indicator" callout box that detects whether the startup command uses Haiku, Sonnet, Opus, or a custom command, and shows a small boxed message with an icon and cost note. This box is unnecessary visual clutter — it takes up space without providing actionable value (the user already knows their startup command). The box should be removed entirely.

### Problem Analysis & Root Cause

The callout box is rendered in the `renderCommsMonitorSection` function (around line 8925-8950 of `src/webview/kanban.html`). It consists of:
1. A `detectModel()` helper function that parses the resolved command string for model keywords.
2. A `modelRow` div with inline styles that displays the detected model name, an icon (💰 for Haiku, ⚠️ otherwise), and a cost note.

This was likely added as a helpful hint to encourage Haiku usage for cost efficiency, but in practice it's just noise — the user configures the command themselves and doesn't need a persistent callout reminding them about model choice.

## Metadata

- **Tags:** ui-cleanup, comms-tab, kanban-html
- **Complexity:** 2

## Complexity Audit

**Routine.** This is a pure deletion of a self-contained UI element. No backend changes, no state changes, no dependencies. The `detectModel` helper and `modelRow` div are only used for this callout — removing them has no side effects.

## Edge-Case & Dependency Audit

- The `detectModel()` function and `modelInfo` variable are local to the render function and not referenced elsewhere.
- The `mcpMonitorResolvedCmd` variable is still used by the startup command display (Issue 2 addresses that separately) — do NOT remove the variable, only the model indicator UI.
- No backend messages are tied to this box; it's purely cosmetic.

## Proposed Changes

### `src/webview/kanban.html` — Remove model indicator block (~lines 8925-8950)

Delete the entire "Model Indicator (Haiku cost highlight)" section:

```javascript
// REMOVE this entire block:
// ─── Model Indicator (Haiku cost highlight) ───
const detectModel = (cmd) => {
    if (!cmd || !cmd.trim()) return { name: 'Unknown', isHaiku: false, isCustom: false };
    const lower = cmd.toLowerCase();
    if (!lower.includes('claude')) return { name: 'Custom command', isHaiku: false, isCustom: true };
    if (lower.includes('haiku')) return { name: 'Haiku', isHaiku: true, isCustom: false };
    if (lower.includes('sonnet')) return { name: 'Sonnet', isHaiku: false, isCustom: false };
    if (lower.includes('opus')) return { name: 'Opus', isHaiku: false, isCustom: false };
    return { name: 'Default (not Haiku)', isHaiku: false, isCustom: false };
};
const modelInfo = detectModel(mcpMonitorResolvedCmd);
const modelIcon = modelInfo.isHaiku ? '💰' : '⚠️';
const modelColor = modelInfo.isHaiku ? 'var(--accent-teal)' : 'var(--text-secondary)';
const modelNote = modelInfo.isHaiku
    ? 'Using Haiku to minimize token costs. Each check is a short read-only query — Haiku is ideal.'
    : modelInfo.isCustom
        ? 'Custom command detected. Model unknown — verify it uses Haiku for cost efficiency.'
        : 'Not using Haiku. This monitor runs frequently — consider --model claude-haiku-4-5 to reduce costs.';
const modelRow = document.createElement('div');
modelRow.style.cssText = 'padding:6px 8px; margin:0 8px 8px 8px; border:1px solid var(--border-color); border-radius:4px; background:var(--panel-bg2); font-size:9px; line-height:1.4;';
modelRow.innerHTML = `
    <span style="color:${modelColor};">${modelIcon}</span>
    <strong style="color:var(--text-primary);">Model: ${modelInfo.name}</strong><br>
    <span style="color:var(--text-secondary);">${modelNote}</span>
`;
container.appendChild(modelRow);
```

The block between the "Dependency Notice" (`depNotice`) and the "Resolved startup command" (`cmdDetails`) should be removed cleanly, leaving the dependency notice flowing directly into the startup command display.

## Verification Plan

1. Open the Kanban board and switch to the Comms tab.
2. Verify the Haiku/model callout box is no longer present.
3. Verify the Prerequisites notice and startup command display still render correctly.
4. Verify the On/Off dropdown and config panel still function normally.
