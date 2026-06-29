# Remove the Per-Card "Pair" Button (Rely on the Pair-Mode Dropdown)

## Goal

Remove the per-card **Pair** button from kanban cards. Pairing remains fully available through the existing **Pair Programming mode dropdown** (`pairProgrammingModeSelect`), which already auto-pairs on the normal advance/dispatch flow. This de-crowds every high-complexity PLAN REVIEWED card — epics most of all, where Pair, Copy prompt, and Orchestrate currently compete.

### Problem Analysis

A high-complexity epic in PLAN REVIEWED currently renders five action buttons: **Pair · Copy coder prompt · Orchestrate · ✎ · ✓**. Three of those (Pair, Copy prompt, Orchestrate) are *different dispatch semantics for the same card*, with no on-card guidance about which to press. For epics this is acute because **Orchestrate** is the canonical epic dispatch (whole epic + subtasks via subagents), while **Pair** is a second, overlapping way to dispatch the same epic+subtasks split into Lead/Coder.

The per-card Pair button is **redundant**. The pair-mode dropdown (`kanban.html:2504`, modes: off / cli-cli / cli-ide / ide-cli / ide-ide) is the intended pairing mechanism: when set to anything but `off`, the normal way a high-complexity card advances to Lead automatically generates and dispatches the Coder prompt via `_dispatchWithPairProgrammingIfNeeded` (`KanbanProvider.ts:3654`), which is wired into **9 dispatch sites** (drag-to-LEAD-CODED, the configured column action, and the column advance/prompt-all buttons — `5619, 5641, 5677, 6074, 6133, 6295, 6432, 6558, 6646`). The per-card button (`pairProgramCard` handler, `KanbanProvider.ts:7053`) does the same Lead+Coder split for a single card.

### Root Cause

The per-card Pair button (1 entry point) and the dropdown auto-pair (9 entry points) are two front-ends to the same Lead+Coder split. The button's only capability the dropdown lacks is "pair this one card while the global mode is `off`" — a narrow niche. The button reads the dropdown mode only to choose IDE-vs-CLI routing (`:7075`); it does not require the mode to be on. The result is duplicated surface area and the "which button do I press?" confusion, concentrated on the cards that already carry the most buttons (high-complexity plans and epics).

## Metadata

**Tags:** frontend, backend, ui, refactor
**Complexity:** 2

## User Review Required

No open product questions. The user has already approved full removal (rejected epic-only suppression and tooltip alternatives). This plan is ready for implementation.

## Decision (no open product questions)

- **Remove the per-card Pair button entirely.** Pairing is configured once in the dropdown (a persistent global toggle) and then happens automatically on advance. This is the cleaner mental model and matches the system's own weighting (9 auto-pair call sites vs. 1 button).
- **Accept the one lost capability:** "pair a single card while global mode is off." The replacement is flipping the dropdown — a one-time, persistent setting. This is an acceptable trade for removing redundant per-card surface area.
- **Surgical removal only.** Keep the dropdown and the entire auto-pair machinery intact (see "What stays" below). This change removes a UI entry point, not the feature.

### Rejected Alternatives
- *Suppress Pair on epics only (Option 2)* — rejected by user in favor of full removal; it would leave the redundancy on every non-epic high-complexity card.
- *Keep Pair, add tooltip/help to disambiguate* — rejected: does not reduce button count; the redundancy with the dropdown remains.

## Complexity Audit

### Routine
- Delete the `.pair-program-btn` click listener (`kanban.html:5261-5267`).
- Delete `numericScore`, `isHighComplexity`, and `pairProgramBtn` (`kanban.html:5370-5374`) — `numericScore`/`isHighComplexity` are used **only** by the Pair button (confirmed by grep), so they become dead with it.
- Delete the `${pairProgramBtn}` insertion in the card-actions markup (`kanban.html:5414`).
- Delete the `case 'pairProgramCard':` handler (`KanbanProvider.ts:7053-7117`) — no other code posts `pairProgramCard`.
- Remove the `simulatePairButtonFlow` helper function (`pair-programming-comprehensive.test.ts:41-105`) — it becomes dead code once all button-only suites are removed.
- Remove button-only test suites (see Edge-Case section for full list).

### Complex / Risky
- None. This is removal of one UI entry point plus its now-orphaned message handler. No schema change, no shipped-state dependency, no migration.

## Edge-Case & Dependency Audit

### What MUST stay (do not touch — the feature lives here)
- The dropdown `pairProgrammingModeSelect` (`kanban.html:2504`) and its `updatePairProgrammingMode` round-trip.
- `_autobanState.pairProgrammingMode` and its config-state normalization/migration (`autobanState.ts:69,257`; `TaskViewerProvider.ts:432,7105`).
- `_dispatchWithPairProgrammingIfNeeded` (`KanbanProvider.ts:3654`) and all 9 call sites.
- The lead-batch auto-coder dispatch (`TaskViewerProvider.ts:3473`).
- `generateUnifiedPrompt`'s `pairProgrammingEnabled` derivation from the mode (`KanbanProvider.ts:3017`).
- The intern→coder routing bypass under pair mode (`KanbanProvider.ts:785`).
- Aggressive pair programming (`agentPromptBuilder.ts:408`) and the IDE-lead clipboard branches (`5586-5642`).

### Race Conditions
- None. The button handler is synchronous from click to message post; removal eliminates the handler entirely. No concurrent-state risk.

### Security
- None. No credentials, no external input parsing, no privilege boundary involved.

### Side Effects
- Removing `numericScore`/`isHighComplexity` has no side effects — grep confirms they are referenced only at `kanban.html:5370-5374` (the Pair button gating). No other code path reads these variables.
- The `pairProgramCard` message type is transient (not persisted, not migrated). Removing the handler is clean.

### Dependencies & Conflicts
- **Related plan:** `feature_plan_20260629091401_epics-always-high-complexity.md` notes that making epics always High-complexity would cause epics to show the Pair button until this removal plan merges. The two plans are compatible — if Pair is still present when the epics-always-high plan lands, epics simply gain the button temporarily (resolved when this plan merges).
- **No CSS cleanup needed:** There is no `.pair-program-btn` CSS rule in `kanban.html` (the class appears only in the JS `querySelectorAll` selector and the template literal). No style rules to remove.

### Tests
- `src/test/pair-programming-comprehensive.test.ts` **mirrors** (re-implements) the `pairProgramCard` handler rather than importing it (see its header comment, line 38), so removing the handler will **not** break compilation. However, suites that exercise the per-card button flow assert behavior that will no longer have a UI entry point and should be removed/retargeted:
  - **Suite 2 "Hybrid Mode (Pair Button + CLI)"** (line 253) — explicitly the per-card button path → **remove**.
  - **Suite 3 "Full Clipboard Mode — Stage 1"** (line 294) — uses `simulatePairButtonFlow` with `coderUsesIde: true`, testing the button's two-stage clipboard handoff (Lead to clipboard → notification → Coder to clipboard). The dropdown path (`_dispatchWithPairProgrammingIfNeeded`, lines 3681-3689) has a *different* two-stage flow (no Lead-to-clipboard write; notification text differs). These tests assert button-specific notification text and Lead-to-clipboard behavior → **remove**.
  - **Suite 4 "Full Clipboard Mode — Stage 2"** (line 335) — same as Suite 3, uses `simulatePairButtonFlow` → **remove**.
  - **Suite 6 "Edge Cases"** (line 482) — **partial removal**:
    - Test 6.2 "mode is captured at click time" (line 487) — manually simulates the button's snapshot semantics → **remove**.
    - Test 6.3 "Stage 2 writeText succeeds regardless of intermediate clipboard content" (line 529) — uses `simulatePairButtonFlow` → **remove**.
    - Test 6.4 "Unknown complexity cards skip Coder pair dispatch in drag-drop" (line 556) — uses `simulateDragDropFlow` (dropdown path) → **keep**.
  - **`simulatePairButtonFlow` helper** (lines 41-105) — becomes dead code after removing Suites 2, 3, 4, and tests 6.2/6.3 → **remove**.
  - **Keep:** Suite 1 (CLI drag-drop auto-pair), Suite 5 (prompt content), Suite 7 (complexity routing), Suite 8 (config-state migration) — these cover the dropdown path and are unaffected.

### Docs
- A grep of `docs/switchboard_user_manual.md`, `docs/how_to_use_switchboard.md`, and `README.md` for "Pair button", "pair-program-btn", and "per-card Pair" found **no matches**. The docs step is a **confirmed no-op** — no documentation references the per-card Pair button. The Pair *Programming feature* coverage (dropdown-based) stays as-is.

### Optional cleanup
- `designs/kanban_prototype.html` (lines 2447, 2461) contains stale `.pair-program-btn` buttons. This is a design prototype, not production code. Removal is optional and cosmetic — it will not affect functionality.

### No migration
- The button is UI-only and `pairProgramCard` is a transient message type, not persisted state. Nothing shipped depends on the button's existence. Clean removal, no compat shim.

## Dependencies

None. This plan is self-contained and has no blocking dependencies on other plans.

## Adversarial Synthesis

Key risks: (1) test suite pruning could accidentally remove dropdown-path coverage if suite boundaries are misread — mitigated by the explicit suite-by-suite audit above distinguishing `simulatePairButtonFlow` (button) from `simulateDragDropFlow` (dropdown). (2) The `simulatePairButtonFlow` helper becoming dead code could cause lint/compile warnings if left in place — mitigated by explicitly calling for its removal. (3) No docs references exist, so the docs step is a confirmed no-op rather than an open task. Overall risk is very low — this is a pure deletion with no state, no migration, and no cross-file coordination beyond the test pruning.

## Proposed Changes

### 1. `src/webview/kanban.html` — remove the click listener (~5261-5267)
Delete the entire `document.querySelectorAll('.pair-program-btn').forEach(...)` block.

### 2. `src/webview/kanban.html` — remove the button + its dead gating (~5370-5374)
Delete:
```js
const numericScore = parseInt(complexityValue, 10);
const isHighComplexity = complexityValue === 'High' || (!isNaN(numericScore) && numericScore >= 7);
const pairProgramBtn = (card.column === 'PLAN REVIEWED' && isHighComplexity)
    ? `<button class="card-btn pair-program-btn" ...>Pair</button>`
    : '';
```

### 3. `src/webview/kanban.html` — remove the markup insertion (~5414)
Remove the `${pairProgramBtn}` line from the `<div style="display: flex; gap: 4px; flex-wrap: wrap;">` action group.

### 4. `src/services/KanbanProvider.ts` — remove the handler (~7053-7117)
Delete the whole `case 'pairProgramCard': { ... }` block.

### 5. `src/test/pair-programming-comprehensive.test.ts` — prune button-only suites and helper
- Remove the `simulatePairButtonFlow` helper function (lines 41-105).
- Remove Suite 2 "Hybrid Mode (Pair Button + CLI)" (line 253).
- Remove Suite 3 "Full Clipboard Mode — Stage 1" (line 294).
- Remove Suite 4 "Full Clipboard Mode — Stage 2" (line 335).
- Remove tests 6.2 and 6.3 from Suite 6 "Edge Cases" (lines 487, 529); keep test 6.4 (line 556).
- Keep Suites 1, 5, 7, 8 (dropdown/prompt/routing/config coverage).

### 6. Docs — confirmed no-op
A grep of `docs/`, `README.md` found no references to the per-card Pair button. No documentation changes required. The Pair Programming feature coverage (dropdown-based) remains as-is.

### 7. Optional: `designs/kanban_prototype.html` — remove stale Pair buttons
Lines 2447 and 2461 contain `.pair-program-btn` buttons in the design prototype. Optional cosmetic cleanup — does not affect functionality.

## Verification Plan

### Automated Tests
*(Not run in this session — user will run separately.)*
- `npm test` — full suite green after pruning the button-only suites (2, 3, 4, tests 6.2/6.3) and the `simulatePairButtonFlow` helper. The retained pair suites (1, 5, 7, 8, test 6.4) must still pass, proving the dropdown auto-pair path is untouched.

### Manual (installed VSIX — dev does not use `dist/`)
1. A high-complexity (score ≥ 7) plan in PLAN REVIEWED **no longer shows** a "Pair" button; remaining buttons: Copy coder prompt · ✎ · ✓.
2. A high-complexity **epic** in PLAN REVIEWED shows Copy coder prompt · Orchestrate · ✎ · ✓ — no Pair.
3. Set the dropdown to **CLI Lead + CLI Coder**, then advance a high-complexity card to LEAD CODED (drag or column advance): the Coder prompt is still auto-dispatched to the Coder terminal (auto-pair intact).
4. Set the dropdown to an **IDE Coder** mode and advance: the "Copy Coder Prompt" notification still appears.
5. Set the dropdown to **Off** and advance: no Coder prompt is produced (pairing disabled, as expected).

## Recommendation

Complexity 2 → **Send to Intern**. This is a pure deletion across two source files plus test pruning, with no logic changes, no migrations, and no cross-file coordination.
