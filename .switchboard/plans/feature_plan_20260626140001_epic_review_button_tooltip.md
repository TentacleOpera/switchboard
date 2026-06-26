# Fix Epic Card Review Button Tooltip to Say "Review Epic"

## Goal

On the Kanban board, every card's review button (the pencil icon) shows the tooltip **"Review plan"** on hover. For epic cards this is wrong — it should read **"Review epic"**, matching the EPIC badge the card already displays.

### Problem analysis & root cause

The Kanban board renders all cards — both regular plan cards and epic cards — through a single function, `createCardHtml(card)`, in `src/webview/kanban.html` (starts ~line 5250). That function already distinguishes epics from plans in several places using the `card.isEpic` flag:

- `src/webview/kanban.html:5311` — `const epicClass = card.isEpic ? ' epic-card' : '';`
- `src/webview/kanban.html:5312` — `const epicBadge = card.isEpic ? \`<span class="epic-badge">EPIC · …</span>\` : '';`
- `src/webview/kanban.html:5315` — `if (card.isEpic) { … }` (worktree chip)

However, the review button's tooltip is a **hardcoded string literal**, not derived from `card.isEpic`:

```html
<!-- src/webview/kanban.html:5341 -->
<button class="card-btn icon-btn review" data-plan-id="${cardId}" … data-tooltip="Review plan">
```

Because the literal `"Review plan"` is emitted for every card regardless of type, epic cards get the wrong tooltip. This is a purely cosmetic (label) bug — the review action itself is unaffected; only the `data-tooltip` text is wrong.

`card.isEpic` is an optional boolean on the `KanbanCard` interface (`src/services/KanbanProvider.ts:97`), already populated for epic cards (it drives the epic badge and worktree chip on the same card), so the corrected tooltip needs no new data — only a conditional at the existing render site.

### Scope note

The separate per-card buttons that appear on epic cards in the **Epics tab** (`project.html` / `project.js`) are `Copy Link`, `Copy Planning Prompt`, and `Send to Planner` — that tab has **no** review button, so it is out of scope. This bug is exclusively about epic cards rendered on the main Kanban board by `createCardHtml`.

## Metadata

- **Tags:** frontend, ui, bugfix
- **Complexity:** 1 / 10
- **Affected files:** `src/webview/kanban.html` (single render site)
- **User-facing:** Yes (hover tooltip text only)
- **Migration required:** No (no persisted state, no shipped settings touched)

## User Review Required

None.

## Complexity Audit

### Routine
- One-line conditional substituting a static `data-tooltip` attribute value with a `card.isEpic`-driven ternary at an existing render site.
- No new state, no message-passing, no persistence, no provider/TypeScript changes.
- The distinguishing flag (`card.isEpic`) is already in scope and already used three lines above the edit (`src/webview/kanban.html:5311`).
- Risk is essentially nil — the only failure mode is a typo in the template literal.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Cards without `isEpic`:** `card.isEpic` is `undefined`/`false` for normal plan cards, so the ternary falls through to `'Review plan'` — existing behaviour preserved exactly.
- **Tooltip rendering mechanism:** The tooltip uses the `data-tooltip` attribute (a custom CSS/JS tooltip), not the native `title` attribute. Changing the attribute value is sufficient; no tooltip-engine change is needed. (Verify there is no JS that reads/caches the old literal — see Verification.)
- **HTML escaping:** Both candidate strings (`"Review epic"`, `"Review plan"`) are static, alphanumeric, and contain no characters requiring escaping, so they can be interpolated directly into the template literal without `escapeAttr`/`escapeHtml`.
- **Single render path:** Because epics and plans share `createCardHtml`, there is no second site to keep in sync — the fix is localized.
- **No other "Review plan" literals:** A repo search (`grep -n "Review plan" src/webview/kanban.html`) confirms line 5341 is the only occurrence in the card renderer. Re-confirm at implementation time in case other tooltips were added.
- **Build/dev note:** Per project rules, `dist/` is not used in dev/testing — editing `src/webview/kanban.html` is sufficient; no `npm run compile` needed for verification via the installed VSIX.

## Dependencies

None.

## Adversarial Synthesis

Key risks: structural omissions (missing sections, non-compliant tags, flat Complexity Audit) and a verification step that called for compilation the session prohibits. Mitigations: all structural gaps now filled; verification plan updated to static grep only. The technical fix itself is zero-risk — a one-line ternary at a confirmed render site using an already-populated flag.

## Proposed Changes

### `src/webview/kanban.html`

Introduce a `reviewTooltip` constant immediately after `cardId` is computed (line 5329) and reference it in the review button's `data-tooltip` (line 5341).

**Before** (lines 5329–5343, abridged):

```javascript
            const cardId = escapeAttr(card.planId || card.sessionId || '');
            return `
                <div class="kanban-card${completedClass}${epicClass}" …>
                    …
                        <div style="display: flex; gap: 4px;">
                            <button class="card-btn icon-btn review" data-plan-id="${cardId}" data-session="${escapeAttr(card.sessionId || '')}" data-plan-file="${escapeAttr(card.planFile || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="Review plan">
                                <svg …></svg>
                            </button>
                            ${completeOrDoneBtn}
                        </div>
```

**After:**

```javascript
            const cardId = escapeAttr(card.planId || card.sessionId || '');
            const reviewTooltip = card.isEpic ? 'Review epic' : 'Review plan';
            return `
                <div class="kanban-card${completedClass}${epicClass}" …>
                    …
                        <div style="display: flex; gap: 4px;">
                            <button class="card-btn icon-btn review" data-plan-id="${cardId}" data-session="${escapeAttr(card.sessionId || '')}" data-plan-file="${escapeAttr(card.planFile || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" data-tooltip="${reviewTooltip}">
                                <svg …></svg>
                            </button>
                            ${completeOrDoneBtn}
                        </div>
```

Only two lines change: the new `const reviewTooltip = …` declaration, and `data-tooltip="Review plan"` → `data-tooltip="${reviewTooltip}"`.

## Verification Plan

### Automated Tests

None applicable — this is a purely cosmetic template-literal change with no testable logic path.

### Manual Checks

1. **Static check:** `grep -n "reviewTooltip\|data-tooltip=\"Review" src/webview/kanban.html` — confirm `reviewTooltip` is declared once and the review button interpolates `${reviewTooltip}` (no remaining hardcoded `"Review plan"` on the button).
2. **Epic card:** Open the Kanban board with at least one epic card (shows the `EPIC · N subtasks` badge). Hover the pencil/review button → tooltip reads **"Review epic"**.
3. **Plan card:** Hover the review button on a normal (non-epic) card → tooltip still reads **"Review plan"**.
4. **Action regression:** Click the review button on both an epic and a plan card → the review action still triggers correctly (the change is tooltip-only; behaviour must be unchanged).
5. **No tooltip-engine breakage:** Confirm the custom `data-tooltip` tooltip still appears/positions normally for both strings (no JS keyed off the literal text).

## Review Pass (2026-06-26)

### Stage 1 — Grumpy Principal Engineer

Alright, let me look at this. A one-line ternary. The kind of change that should be beneath me, yet here we are.

- **The constant placement.** `reviewTooltip` is declared at `src/webview/kanban.html:5340`, immediately after `cardId` (line 5339) and *before* the `return` template literal (line 5341). Correct scope, correct ordering, no hoisting games. Fine.
- **The ternary.** `card.isEpic ? 'Review epic' : 'Review plan'`. Uses the same flag that drives the epic badge three lines above it (`epicClass` at 5311, `epicBadge` at 5312). No new data plumbing. The fallback preserves the exact legacy string for non-epic cards. Boringly correct.
- **The interpolation.** `data-tooltip="${reviewTooltip}"` at line 5352. Both candidate strings are static, alphanumeric, no quotes/angle brackets — no `escapeAttr` needed, and the plan explicitly audited this. No injection surface.
- **Single render path.** `createCardHtml` is the only card renderer on the Kanban board. A repo-wide grep for `Review plan` / `Review epic` across `src/` returns exactly one hit: the ternary itself at line 5340. No stale literal lingering on a second button, no JS keyed off the old text. The "no tooltip-engine breakage" risk is closed.
- **`isEpic` population.** `KanbanProvider.ts` populates `isEpic` at four card-assembly sites (lines 1236, 1253, 2140, 2159) via `!!row.isEpic`. The flag is real and already consumed by the badge/worktree chip on the same card. No phantom-undefined risk.

**Verdict:** I went looking for a fire and found a damp match. This is a textbook-correct one-line fix at the confirmed render site, using an already-populated flag, with the legacy string preserved verbatim for the non-epic path. No CRITICAL, no MAJOR, no NIT worth the bytes to type it. The plan's own "Risk is essentially nil" claim holds up.

### Stage 2 — Balanced Synthesis

- **Keep as-is:** The entire implementation. The `reviewTooltip` constant declaration and the `data-tooltip="${reviewTooltip}"` interpolation are exactly what the plan specified, at the specified locations.
- **Fix now:** Nothing. No valid material findings.
- **Defer:** Nothing. The change is complete and self-contained.

### Files Changed

- `src/webview/kanban.html:5340` — added `const reviewTooltip = card.isEpic ? 'Review epic' : 'Review plan';`
- `src/webview/kanban.html:5352` — `data-tooltip="Review plan"` → `data-tooltip="${reviewTooltip}"`

### Validation Results

- **Static grep (Verification Plan step 1):** PASS. `reviewTooltip` declared once (line 5340), interpolated once on the review button (line 5352). No remaining hardcoded `"Review plan"` on the button.
- **Repo-wide literal scan:** PASS. `grep -n "Review plan\|Review epic"` across `src/` returns only the ternary at line 5340 — no stale literals, no JS keyed off the text.
- **`isEpic` flag audit:** PASS. Populated at `KanbanProvider.ts:1236,1253,2140,2159`; already consumed by the epic badge and worktree chip on the same card.
- **Compilation:** Skipped per session policy (`dist/` not used in dev; `src/` is source of truth).
- **Automated tests:** Skipped per session policy (cosmetic template-literal change, no testable logic path).

### Remaining Risks

None material. The only residual risk is the un-run manual hover checks (steps 2–5 of the Verification Plan), which require a live VSIX install with epic and plan cards present — out of scope for this static review pass.
