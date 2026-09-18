# Orchestrate Button: Purple Outline Instead of Solid Fill

## Goal

The **Orchestrate** button on epic cards in `kanban.html` currently renders with a solid purple background (`#6b21a8`) and white text. It was intended to follow the same outline styling convention as the other card buttons (Complete, Recover, Copy, etc.) — a transparent background with a coloured border and text, filling only subtly on hover.

### Problem Analysis & Root Cause

**Symptom**: The Orchestrate button is visually inconsistent with every other button in the `.card-actions` row. Other buttons are outline-style (transparent background, thin border, accent colour on hover), while Orchestrate is a solid filled pill.

**Root cause**: In `src/webview/kanban.html`, the `.card-btn.orchestrate` rule (lines 1003-1009) sets an opaque `background` and white `color` at rest, and swaps to a different opaque `background` on hover:

```css
.card-btn.orchestrate {
    background: #6b21a8;
    color: #fff;
}
.card-btn.orchestrate:hover {
    background: #7c3aed;
}
```

This overrides the base `.card-btn` style (lines 973-985: `background: transparent; border: 1px solid var(--border-color); color: var(--text-secondary);`) with a solid fill, breaking the outline convention used by `.card-btn.complete` (lines 993-996), `.card-btn.recover` (lines 998-1001), and `.card-btn.copy`.

**Background context**: Epic cards use `#7c3aed` as their identity colour (purple left border at lines 169, 920; purple selected-state border at lines 1353-1357; purple meta line at line 924). The Orchestrate button was meant to echo that identity as an *outline*, not as a solid block — the solid fill makes it look like a primary CTA and visually dominates the card actions row.

## Metadata

**Tags:** frontend, ui
**Complexity:** 2

## User Review Required

No open product questions. The visual inconsistency is clear and the fix follows the existing outline convention. This plan is ready for implementation.

## Complexity Audit

### Routine
- Replace two CSS rules (`.card-btn.orchestrate` and `.card-btn.orchestrate:hover`) in a single file (`kanban.html`, lines 1003-1009).
- Reuse the existing epic identity colour `#7c3aed` (already proven to work in both dark and light themes — used at lines 169, 181, 920, 924, 1353-1357).
- Use `color-mix(in srgb, ...)` for the hover tint — already used 10+ times elsewhere in the file (lines 27, 28, 37, 57, 58, 149, 170, 235, etc.), so it is a proven-supported CSS function in the VS Code webview.

### Complex / Risky
- None. Pure CSS change to two rules in a single file. No logic, no data flow, no state, no migrations.

## Edge-Case & Dependency Audit

### Race Conditions
- None. CSS is static; no runtime state involved.

### Security
- None. No input parsing, no external data, no privilege boundary.

### Side Effects
- The `.card-btn.orchestrate:hover` override must continue to override the base `.card-btn:hover` rule (lines 987-991), which sets a neutral tinted background. The proposed `:hover` rule explicitly sets `background`, `border-color`, and `color`, fully overriding the base.

### Dependencies & Conflicts
- **Theme compatibility**: `kanban.html` ships two themes — a dark default (`--border-color: #333333`) and a "Claudify" light theme (`--accent-primary: #D97757`). The orchestrate button currently uses hardcoded hex values (`#6b21a8` / `#7c3aed`) rather than theme variables, and the epic identity colour `#7c3aed` is already used hardcoded across both themes (lines 169, 181, 920, 924, 1353-1357). Keeping the same hardcoded `#7c3aed` for the outline preserves the existing cross-theme behaviour — no new variable needs to be introduced.
- **No theme-specific override exists**: A grep for `theme-claudify.*orchestrate` found no matches. The orchestrate CSS rules at lines 1003-1009 apply to both themes. No theme-specific override to update.
- **Hover state**: The base `.card-btn:hover` rule (lines 987-991) sets a neutral tinted background and bright border. The orchestrate-specific hover must override this with a purple-tinted background so the outline identity survives hover.
- **Selected epic cards**: Selected epic cards already apply a purple border/box-shadow to the whole card (lines 1353-1357). A purple-outline button on a purple-bordered card remains distinguishable because the button has its own 1px border and padding — no conflict.
- **No JS dependency**: The button's behaviour (lines 5281-5297, dispatching `orchestrateEpic`) is unaffected; only presentation changes.
- **No migration**: This is unreleased dev styling; no shipped-state to migrate.
- **`#6b21a8` becomes unused**: After this change, `#6b21a8` is no longer referenced anywhere in `kanban.html` (grep confirms it appears only at line 1004). This is expected — the colour is being replaced by the epic identity `#7c3aed`.

## Dependencies

None. This plan is self-contained and has no blocking dependencies on other plans.

## Adversarial Synthesis

Key risks: (1) The 12% purple tint on hover could be too subtle to read as a hover state on the light Claudify theme — mitigated by the fact that the border and text colour remain purple `#7c3aed` on hover, providing a clear visual change from the base `.card-btn:hover` neutral tint. (2) The `color-mix` function could theoretically be unsupported in an older VS Code webview — mitigated by the fact that `color-mix` is already used 10+ times in the same file and the extension ships to modern VS Code only. Overall risk is very low — this is a two-rule CSS change with no logic or state implications.

## Proposed Changes

### File: `src/webview/kanban.html`

Replace the solid-fill `.card-btn.orchestrate` rules (lines 1003-1009) with an outline style that matches the other card buttons, using the epic identity purple `#7c3aed`.

**Before** (lines 1003-1009):

```css
.card-btn.orchestrate {
    background: #6b21a8;
    color: #fff;
}
.card-btn.orchestrate:hover {
    background: #7c3aed;
}
```

**After**:

```css
.card-btn.orchestrate {
    background: transparent;
    border-color: #7c3aed;
    color: #7c3aed;
}
.card-btn.orchestrate:hover {
    background: color-mix(in srgb, #7c3aed 12%, transparent);
    border-color: #7c3aed;
    color: #7c3aed;
}
```

Rationale:
- `background: transparent` restores the outline convention (matches base `.card-btn` at line 974).
- `border-color: #7c3aed` and `color: #7c3aed` give the button its purple identity at rest, consistent with the epic card's purple border/meta line.
- On hover, a subtle 12% purple tint fills the button (mirroring the `color-mix` tint pattern used at line 235) while keeping the purple border and text, so the outline identity survives hover instead of becoming a solid block.
- The `:hover` rule explicitly sets all three properties (`background`, `border-color`, `color`) to fully override the base `.card-btn:hover` rule (lines 987-991).

## Verification Plan

### Automated Tests
*(Not run in this session — user will run separately.)*
- No automated tests cover CSS styling. The test suite will confirm no compilation errors from the HTML change.

### Manual (installed VSIX — dev does not use `dist/`)
1. **Visual check — dark theme**:
   - Open the Kanban board in the default dark theme.
   - Find an epic card (purple left border) that is not in a completed column.
   - Confirm the **Orchestrate** button shows a transparent background with a purple border and purple text, visually matching the outline style of the Complete/Copy buttons next to it.
   - Hover the Orchestrate button: confirm a subtle purple tint fills it and the purple border/text remain.
2. **Visual check — Claudify (light) theme**:
   - Switch to the Claudify theme.
   - Repeat the above checks; the purple outline should remain legible against the light panel background.
3. **Selected-state check**: Click an epic card to select it (purple card border appears). Confirm the Orchestrate button's outline is still visible and distinguishable from the card's selection border.
4. **Functional regression**: Click the Orchestrate button and confirm it still dispatches the `orchestrateEpic` action (the orchestration flow starts as before) — no behavioural change from the CSS edit.

## Recommendation

Complexity 2 → **Send to Intern**. This is a two-rule CSS change in a single file with no logic, no state, and no migration.

---

## Code Review (Reviewer Pass — 2026-06-30)

### Implementation Commit
`104b685` — "Kanban Card Action-Button Cleanup" (auto-commit before code review). **No changes were made for this subtask** — the target CSS rules and Orchestrate button were already absent.

### Superseded by Prior Commit

**MAJOR finding (plan-vs-reality discrepancy):** The plan's proposed CSS replacement target (`.card-btn.orchestrate` rules, formerly at lines 1003-1009) **does not exist** in the current code. The Orchestrate button, its CSS rules, its click handler, and the backend `case 'orchestrateEpic'` handler were **entirely removed** by prior commit `403329d` ("Tickets Tab Sidebar Card Layout & Actions", 2026-06-29T11:31:40), which replaced the Epic Orchestrator with Lead-Coder Dispatch and Workflow Buttons. This commit landed ~8 hours before the epic implementation commit (`104b685`, 20:02:34).

The plan was authored against a codebase state that was already obsolete by the time implementation began. The proposed CSS change is a **no-op** — there is nothing to restyle.

### Stage 1 (Grumpy) Findings

| Severity | Finding | Location |
|----------|---------|----------|
| MAJOR | Plan-vs-reality discrepancy: the `.card-btn.orchestrate` CSS rules and the Orchestrate button do not exist. Removed entirely by prior commit `403329d` (2026-06-29T11:31). The plan was written against stale code. | `src/webview/kanban.html` (target absent) |
| NIT | The proposed `color-mix(in srgb, #7c3aed 12%, transparent)` hover tint is moot — no rule to apply it to. | N/A (moot) |

No CRITICAL findings. The MAJOR finding is a plan accuracy issue, not a code defect.

### Stage 2 (Balanced) — Synthesis

**Keep as-is:** The current code state. The Orchestrate button and its solid-fill CSS are fully gone (removed by `403329d`). The epic's goal — eliminating the visual inconsistency where Orchestrate was a solid purple fill while every other card button used outline style — is **achieved more thoroughly** than the plan proposed: there is no button to be inconsistent. No code fix is needed or possible.

**Fix now:** Nothing. The proposed CSS change is a no-op (target rules don't exist). The outcome satisfies the epic's goal.

**Defer:** N/A — nothing to defer because there is nothing to implement.

### Code Fixes Applied
None required. The plan was superseded by a prior commit that achieved the goal more thoroughly (full removal vs. restyle).

### Validation Results
- **Grep verification:** Zero references to `orchestrate`, `card-btn.orchestrate`, `orchestrateEpic`, or `#6b21a8` in `src/webview/kanban.html` or `src/services/KanbanProvider.ts`.
- **Epic identity color intact:** `#7c3aed` confirmed present in 9 places in `kanban.html` (card borders at lines 169, 181, 920; meta line at 924; selected-state at 1348-1350). No collateral damage to epic card styling.
- **Git history:** Commit `403329d` removed the target CSS and button; commit `104b685` (epic implementation) made zero Orchestrate-related changes to `kanban.html` (14 deletions, all Pair-button removal from Subtask 1).
- **Compilation:** Skipped per session instructions.
- **Automated tests:** Skipped per session instructions.

### Remaining Risks
- **None (code):** The code is in the desired state — no Orchestrate button, no solid-fill inconsistency.
- **Process note:** The plan was not re-validated against current code before implementation. The proposed changes could not be applied because the target was removed by an intervening commit. This is a process gap (plan staleness), not a code risk. The epic's goal is satisfied regardless.
