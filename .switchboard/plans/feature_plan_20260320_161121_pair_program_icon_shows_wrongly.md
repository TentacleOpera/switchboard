# Pair program icon shows wrongly

## Goal
Pair program icon appears on low complexity cards as well as high. the original spec clearly said that it should ONLY appear on high complexity cards, as it will have no effect for low complexity. IT's also meant to be on the LEFT side next to the copy prompt button.

## Proposed Changes

### [Fix visibility guard for pair program button]
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The pair program button was rendering on all cards regardless of complexity.
- **Fix:** Added a conditional that only renders the button when `card.column === 'PLAN REVIEWED' && complexity === 'High'`. Low complexity and Unknown complexity cards get an empty string.
- **Implementation:** The `pairProgramBtn` variable is set via a ternary that checks both column and complexity before rendering the button HTML.

### [Fix button placement — move to left side]
#### [MODIFY] `src/webview/kanban.html`
- **Context:** The pair program button was positioned on the wrong side of the card actions.
- **Fix:** Moved `${pairProgramBtn}` to render *before* the copy prompt button inside a left-aligned flex container (`display: flex; gap: 4px;`), so it appears on the LEFT next to the copy button.

## Verification Plan
- Visual inspection: pair program button should only appear on PLAN REVIEWED cards with `High` complexity.
- Visual inspection: pair program button should appear to the LEFT of the copy prompt button.
- Functional test: clicking the pair program button on a High complexity card copies the lead prompt and dispatches the coder prompt.

## Open Questions
- None remaining.

---

## Implementation Review — 2026-03-20

### Status: ✅ APPROVED (no code fixes needed; plan file populated)

### Files Changed During Review
- `feature_plan_20260320_161121_pair_program_icon_shows_wrongly.md` — Populated TODO sections with actual implementation details retroactively.

### Findings

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | Plan file was entirely TODOs with no implementation record | **MAJOR** (process) | **Fixed** — plan populated with implementation details |
| 2 | Visibility guard `(card.column === 'PLAN REVIEWED' && complexity === 'High')` correctly restricts button to high complexity only | PASS | Kept |
| 3 | Button placement in flex container renders left of copy button | PASS | Kept |
| 4 | No lightning bolt icon present in current button text ("Pair") | NIT | Documented — appears already removed |

### Validation Results
- **TypeScript typecheck (`tsc --noEmit`)**: ✅ Pass (0 errors)
- **Webpack build**: ✅ Pass
- **Code review**: Implementation in `kanban.html` lines 1161–1171 correctly implements both requirements from the Goal

### Remaining Risks
- None. The fix is purely UI conditional logic with no side effects.
