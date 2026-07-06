# Remove Haiku Model Callout Box in Comms Tab

## Goal

The Comms Monitor tab in `kanban.html` displays a "Model Indicator" callout box that detects whether the startup command uses Haiku, Sonnet, Opus, or a custom command, and shows a small boxed message with an icon and cost note. This box is unnecessary visual clutter — it takes up space without providing actionable value (the user already knows their startup command). The box should be removed entirely.

### Problem Analysis & Root Cause

The callout box is rendered in the `renderCommsMonitorSection` function (around lines 8933-8958 of `src/webview/kanban.html`). It consists of:
1. A `detectModel()` helper function that parses the resolved command string for model keywords.
2. A `modelRow` div with inline styles that displays the detected model name, an icon (💰 for Haiku, ⚠️ otherwise), and a cost note.

This was likely added as a helpful hint to encourage Haiku usage for cost efficiency, but in practice it's just noise — the user configures the command themselves and doesn't need a persistent callout reminding them about model choice.

## Metadata

- **Tags:** ui
- **Complexity:** 2

## User Review Required

No — pure deletion of a self-contained cosmetic UI block. No logic, state, or backend changes.

## Complexity Audit

### Routine
- Pure deletion of a self-contained UI element (the `detectModel` helper + `modelRow` div).
- No backend changes, no state changes, no dependencies. The `detectModel` helper and `modelRow` div are only used for this callout — removing them has no side effects.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- The `detectModel()` function and `modelInfo` variable are local to the render function and not referenced elsewhere.
- The `mcpMonitorResolvedCmd` variable is still used by the startup command display (Issue 2 addresses that separately) — do NOT remove the variable, only the model indicator UI.
- No backend messages are tied to this box; it's purely cosmetic.

## Proposed Changes

### `src/webview/kanban.html` — Remove model indicator block (~lines 8933-8958)

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

## Dependencies

- None — this subtask deletes a self-contained block (lines 8933-8958) independent of the other two subtasks.
- The block sits between the Dependency Notice (`depNotice`, ends line 8931) and the startup command accordion (`cmdDetails`, starts line 8960). Removing it leaves `depNotice` flowing directly into `cmdDetails` — no reconnect logic needed.

## Adversarial Synthesis

Key risks: none material — the `detectModel` helper and `modelInfo`/`modelIcon`/`modelColor`/`modelNote`/`modelRow` variables are all local to the render function and unreferenced elsewhere. Mitigation: confirm `mcpMonitorResolvedCmd` (read by `detectModel`) is NOT removed — it is still consumed by the startup command display (subtask 1).

## Verification Plan

1. Open the Kanban board and switch to the Comms tab.
2. Verify the Haiku/model callout box is no longer present.
3. Verify the Prerequisites notice and startup command display still render correctly.
4. Verify the On/Off dropdown and config panel still function normally.
5. Skip compilation and automated tests per session directives — visual verification only.

## Review Findings

Implemented and committed in `cbb3771` (`src/webview/kanban.html`). The `detectModel` helper and `modelRow`/`modelInfo`/`modelIcon`/`modelColor`/`modelNote` block are fully removed — grep returns zero remaining references anywhere in the file — and `depNotice` (~9056) now flows directly into the startup command block (~9058) with no dangling separator. Shared `mcpMonitorResolvedCmd` was correctly spared (still read at 9064). Regression sweep confirmed no positional child indexing on the comms container (the `container.children[i]` at 7116 is unrelated autoban-badge code). No CRITICAL/MAJOR findings; no code changes required; compile/tests skipped per session directives.
