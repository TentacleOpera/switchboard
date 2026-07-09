# Kanban HTML Visual Fixes

**Complexity:** 4

## Goal

Group of 2 kanban.html visual fixes: add accordion to Subagent Policy section in prompts tab (matching Git Strategy pattern), and restore coding-status card animation under Claudify theme (box-shadow override).

## How the Subtasks Achieve This

- **Prompts Tab Accordion Consistency — Subagent Policy & Git Safety Guardrail**: Makes the Subagent Policy radio group collapsible across every role so it matches the existing Git Strategy accordion. Adds a `group: 'subagent'` tag so the dynamic renderer (`renderRoleAddons`) wraps the radio in the same `<details class="addon-subsection-accordion">` used for Git Strategy, and wraps the planner's hardcoded HTML block in a matching accordion. Delivers the visual-consistency goal: every multi-option Prompts-Tab section collapses the same way.
- **Replace Pulsing Working Animation with Theme-Specific Static Highlight**: Removes the distracting pulsing amber glow on working kanban cards and replaces it with a calm, static 2px border ring colored per active theme (blue for Afterburner, orange for Claudify). Delivers the calmer working-indicator goal — no animation, theme-aware color.

## Dependencies & sequencing

- No cross-feature dependencies; both subtasks are independent frontend changes confined to `src/webview/kanban.html` (plus `src/webview/sharedDefaults.js` for the accordion tag). No backend, no data migration.
- Shipping order: either order is safe — the two edits occupy disjoint regions of `kanban.html` (accordion work in the ~3.0k HTML / ~3.6k JS lines; animation work in the ~960 CSS lines), so there is no regional overlap and no merge conflict either way.
- Prerequisites/guards: both require a webview reload to render; no compile or test step is needed for dev verification (per project rules `dist/` is not used during development — `src/` is the source of truth).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature Plan: Prompts Tab Accordion Consistency — Subagent Policy & Git Safety Guardrail](../plans/feature_plan_20260708120900_prompts-tab-accordion-consistency.md) — **CODE REVIEWED**
- [ ] [Feature Plan: Replace Pulsing Working Animation with Theme-Specific Static Highlight](../plans/feature_plan_20260708120901_kanban-card-coding-animation-claudify-override.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Review Findings

Reviewer pass (2026-07-09) with advanced regression analysis. **Subtask 1 (accordion)** implemented correctly: shared `SUBAGENT_POLICY_RADIO` constant (`sharedDefaults.js:86`, `group: 'subagent'`, 10 role refs, no orphan inline descriptor), `prettyGroupLabel` maps `'subagent'` (`kanban.html:3702`), planner block wrapped in `<details>` (`kanban.html:3078`) with custom-input listener (`kanban.html:4377`) verified resolving inside the accordion. **Subtask 2 (animation):** a prior `restore-kanban-working-animation.md` commit had re-added the pulse; the user re-confirmed the original intent, so the animation, `@keyframes`, `prefers-reduced-motion` gate, and glow spread were removed. `.kanban-card.is-working::after` is now a static theme-colored 2px ring (Afterburner `#00e5ff`, Claudify `#D97757`, `kanban.html:983/988`); no orphaned `kanban-working-pulse` refs remain. Compile/tests skipped per directive. Remaining risk: none — pure CSS + static DOM, `subagentPolicy` group tag is inert to prompt output.

