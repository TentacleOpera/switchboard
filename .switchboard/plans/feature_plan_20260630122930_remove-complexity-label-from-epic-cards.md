# Remove "Complexity:" Word from Epic Kanban Cards

## Goal

**Problem:** On the Kanban board, epic cards render their meta line as
`EPIC: N SUBTASKS · Complexity: <level>`. The literal `Complexity: ` prefix
wastes horizontal space on the already cramped card, leaving insufficient room
for the subtask count and the colored complexity level label.

**Root cause:** In `src/webview/kanban.html`, the `createCardHtml()` function
builds the epic card's meta line with a hard-coded `Complexity: ` string
prefixing the colored `<span class="complexity-indicator">` element. The plan
(non-epic) card meta line uses the same prefix but must remain unchanged per
the user's instruction.

**Desired outcome:** Epic cards show `EPIC: N SUBTASKS · <level>` (e.g.
`EPIC: 3 SUBTASKS · High`), with the complexity level still color-coded via the
existing `.complexity-indicator` CSS classes. Plan cards keep their current
`Complexity: <level> · <timeAgo>` formatting.

## Metadata

- Tags: `ui`, `bugfix`
- Complexity: 2 (single-line string edit, no logic change)

## User Review Required

No. This is a trivial cosmetic string edit with no logic, state, or data-model
impact. The change is fully specified by the "Before"/"After" diff below and
can be applied directly.

## Complexity Audit

### Routine
- Single-line edit to a template literal inside a pure rendering function (`createCardHtml`).
- No data model, state, persistence, or routing logic is touched.
- The complexity category value and its CSS color class are computed unchanged upstream (`scoreToCategory` at line 5266, `categoryToCssClass` at line 5279; consumed at lines 5287-5288).
- Only the literal label text is removed for epic cards; the colored `<span class="complexity-indicator">` element is retained.
- The `·` middle-dot separator is preserved verbatim.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. This is a synchronous string template evaluated during `createCardHtml()` rendering. No async state, no shared mutable data.
- **Security:** None. No user input is interpolated into the changed region; the edit removes a static literal. No new injection surface.
- **Side Effects:** None. Pure view-layer string change; no persisted state, settings, or kanban DB columns are affected. No migration impact.
- **Dependencies & Conflicts:**
  - **Plan cards must not change.** The fix targets only the `card.isEpic` branch of the ternary at line 5343. The non-epic branch (line 5344) is left intact.
  - **No CSS dependency.** The `.complexity-indicator` styling continues to apply to the retained `<span>`. No selector changes needed.
  - **Unknown complexity.** When `card.complexity` is falsy, `category` resolves to `Unknown` and `complexityClass` to `unknown`. Removing the `Complexity: ` prefix still leaves the colored `Unknown` label — behavior preserved.
  - **Completed epic cards.** The meta line is rendered regardless of `isCompleted`; the change applies uniformly, which is correct.

## Dependencies

None. This plan is self-contained and has no prerequisite sessions.

## Adversarial Synthesis

Key risks: none material — this is a verified single-line cosmetic edit isolated to the epic branch of a rendering ternary, with the plan-card branch preserved byte-for-byte. A minor accessibility observation (removing the `Complexity: ` label reduces explicit context for screen readers) was considered and rejected as non-blocking because the user explicitly requested the space optimization and the color-coded level word remains visible. Mitigations: none required beyond applying the diff exactly as specified.

## Proposed Changes

### `src/webview/kanban.html` — `createCardHtml()` epic meta line (line 5343)

Remove the literal `Complexity: ` prefix from the epic branch of the
`cardMetaContent` ternary. Keep the `·` separator and the colored
`complexity-indicator` span.

**Before:**
```js
const cardMetaContent = card.isEpic
    ? `<span class="epic-subtask-label">EPIC: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span>`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}`;
```

**After:**
```js
const cardMetaContent = card.isEpic
    ? `<span class="epic-subtask-label">EPIC: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · <span class="complexity-indicator ${complexityClass}">${category}</span>`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}`;
```

Only the epic branch is modified; the plan-card branch is unchanged.

## Verification Plan

### Automated Tests

No automated tests are run for this session per directive. The test suite will
be run separately by the user.

### Manual Verification

1. **Source inspection:** Confirm only line 5343 changed; line 5344 (plan
   cards) is byte-identical to the original.
2. **Manual UI check (via installed VSIX):**
   - Open the Kanban board with at least one epic card present.
   - Confirm the epic card meta reads `EPIC: N SUBTASKS · <Level>` with the
     level word still color-coded (e.g. red for `High`).
   - Confirm a non-epic plan card still reads
     `Complexity: <Level> · <timeAgo>` unchanged.
   - Confirm an epic with unknown complexity shows `EPIC: N SUBTASKS · Unknown`
     in the muted `unknown` color.
3. **No regressions:** Card drag, Copy Prompt, Recover, and Complete buttons
   remain functional (unchanged code paths).

## Recommendation

Complexity 2 → **Send to Intern**.
