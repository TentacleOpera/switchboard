# Part 4 — Directive Wiring Centralization (cross-cutting)

**Plan ID:** 51d9c2a2-b0db-4b05-b195-6fb581e43c26
**Epic ID:** 8b50c095-b7c6-40b5-a9d6-2155b26fe4b6

## Metadata

**Complexity:** 4
**Tags:** backend, refactor

---

## Goal

Centralize the three orchestration-directive variants (`none`/`per-subtask`/`high-low`) in
`agentPromptBuilder.ts`, select by the epic's mode at prompt-build time, and confirm no directive
variant changes behavior for non-epic plans or `none`-mode epics. This is the finalization step
that wires the variants Parts 2 & 3 defined into a single selection path.

### Core problem & background

Parts 2 & 3 each add a directive variant to `agentPromptBuilder.ts`. Without centralization, the
selection logic scatters across the prompt-build path. This plan consolidates selection into one
place and guards against regressions for non-epic / `none`-mode dispatch.

---

## User Review Required

No — this is a pure refactor/wiring step with no product-scope decisions.

## Complexity Audit

### Routine
- Centralize three directive variants behind a single selector function keyed on
  `epic_worktree_mode`.
- Gate the planner consolidation directive to `high-low` epics only (already specified in Part 3;
  this plan confirms the gate).

### Complex / Risky
- None significant — reuses variants defined in Parts 2 & 3.

## Edge-Case & Dependency Audit

- **Race Conditions:** none — prompt building is synchronous per dispatch; mode is read once.
- **Security:** no new user input surfaces.
- **Side Effects:** a misrouted directive variant could change behavior for non-epic plans — the
  acceptance test guards against this.
- **Dependencies & Conflicts:** must land AFTER Parts 2 & 3 define their variant shapes, or the
  variants won't exist to centralize. No conflict with Part 0 (directive scope fix) — Part 0
  governs the ultracode/goal prefix; this plan governs the orchestration directive.

## Dependencies

- `sess_epicworktree_per_subtask` — Part 2 defines the `per-subtask` directive variant.
- `sess_epicworktree_high_low` — Part 3 defines the `high-low` directive variant + planner
  consolidation directive.
- `sess_epicworktree_mode_config` — Part 1 provides the mode value used for selection.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
- **Context:** `EPIC_ORCHESTRATION_DIRECTIVE` (~350) is the base directive; Parts 2 & 3 add
  `per-subtask` and `high-low` variants. `buildKanbanBatchPrompt` injects the epic directive at
  ~522.
- **Logic:**
  1. Centralize the three orchestration-directive variants (`none`/`per-subtask`/`high-low`) behind
     a single selector (e.g. `resolveEpicOrchestrationDirective(mode, epicTopic, count,
     worktreePaths?)`) in `agentPromptBuilder.ts`; select by the epic's mode at prompt-build time
     (~522).
  2. Ensure the planner consolidation directive is gated to `high-low` epics only (confirm the gate
     added in Part 3; tighten here if needed).
  3. Confirm no directive variant changes behavior for non-epic plans or `none`-mode epics —
     `none`-mode epics keep the base `EPIC_ORCHESTRATION_DIRECTIVE` unchanged.
- **Edge Cases:** mode value unset or `'none'` → base directive (current behavior). Unknown mode
  value → fall back to base + log a warning.

### `src/services/KanbanProvider.ts`
- **Context:** `generateUnifiedPrompt` (~3147) resolves options including `epicMode` (~3288); the
  epic-directive injection at ~522 (in agentPromptBuilder) consumes it.
- **Logic:** pass the epic's `epic_worktree_mode` (read from config) into `resolvedOptions` so the
  selector in `agentPromptBuilder.ts` can read it. If `epicMode` is already set (from
  `hasSubtasks` block ~3284), extend it with the mode.
- **Edge Cases:** non-epic dispatch → mode is irrelevant; the selector must no-op.

## Verification Plan

### Automated Tests
- **SKIP for this session** per session directives. Tests to author for the separate run:
  - Assert `none`-mode epic dispatch uses the base `EPIC_ORCHESTRATION_DIRECTIVE` (byte-identical
    to pre-change output).
  - Assert `per-subtask` mode selects the per-subtask variant; `high-low` selects the high-low
    variant.
  - Assert non-epic plan dispatch is unchanged (no epic directive injected).

### Manual / Static Verification (this session)
- **Compilation SKIP** per session directives.
- Static cross-check (done during review): confirmed `EPIC_ORCHESTRATION_DIRECTIVE` (~350) and the
  injection point (~522) against current `src/`.
- Pre-merge checklist: grep for any new `confirm(`/`window.confirm` — forbidden per CLAUDE.md.

## Acceptance
- `none`-mode epic dispatch is byte-identical to current behavior.
- `per-subtask` / `high-low` modes select their respective variants.
- Non-epic plan dispatch is unchanged.
- Planner consolidation directive fires only for `high-low` epics.

## Recommendation

Complexity 4 → **Send to Coder.** Pure wiring/refactor; reuses variants from Parts 2 & 3. Ships
last, after Parts 2 & 3 land.

---

## Review Findings

Reviewed `src/services/agentPromptBuilder.ts` (`resolveEpicOrchestrationDirective` selector + `buildKanbanBatchPrompt` wiring + planner consolidation gate) and `src/services/KanbanProvider.ts` (`resolvedOptions` threading `epicWorktreeMode`/`epicPlanId`/`tierWorktrees`/`subtaskPlansForConsolidation`). Implementation matches the plan: a single selector keyed on mode, the planner consolidation directive gated to `high-low` + planner role + a non-empty subtask list, and `none`/unknown modes falling back to the base `EPIC_ORCHESTRATION_DIRECTIVE`. Verified byte-identical preservation: for `none`-mode and all existing/legacy epics no `subtask_plan_id`/`tier` worktree rows exist, so `subtaskWorktrees` is empty and the selector returns the base directive unchanged; non-epic dispatch injects no directive. No code fixes required: the selector's intentional deviation (consulting `subtaskWorktrees` independent of the live mode, to handle rows outliving a mode toggle) is documented in-code and only affects epics that previously had per-subtask worktrees. Validation: static only (compilation/tests skipped); no confirm-gates. Remaining risk: none material.
