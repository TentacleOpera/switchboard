# Kanban & Onboarding UI Polish

**Complexity:** 3

## Goal

Four UI-polish fixes across the kanban board, setup Theme tab, and first-install onboarding: active-state tooltip for the Create Worktree button, live-apply of Claudify colour icons on theme switch, American 'color' spelling in the colour-icons label/description, and Core/Optional subheaders in the agents list.

These four are grouped because they are small, low-risk presentation/UX fixes to the same surface area (the kanban webview and the setup/onboarding webviews) that are best reviewed and shipped as one polish pass rather than as scattered one-off tickets.

## How the Subtasks Achieve This

- **Create Worktree Button Has No Tooltip When Active**: Makes `updateCreateWorktreeButton()` in `kanban.html` *set* a descriptive `data-tooltip` in its two enabled branches (no selection → active project/workspace; single feature → that feature) instead of stripping it, so the button explains its action in every state, not only when disabled.
- **Claudify "Colour Kanban Board Icons" Not Applied Live When Switching to Claudify**: Adds a `colourKanbanIconsChanged` broadcast (carrying the effective, theme-derived value from `getEffectiveColourKanbanIcons()`) to the `switchboard.theme.name` config watcher in `TaskViewerProvider`, so a live switch to Claudify colours the icons immediately instead of only after a reload.
- **"Colour Kanban Board Icons" Label & Description Should Use American "Color"**: Edits only the two user-facing display strings (`setup.html` Theme-tab label/description and the `package.json` settings description) from "colour" to "color", leaving the config key and all internal identifiers British — aligning the copy with the rest of the product without a migration.
- **Agents List Needs "Core" / "Optional" Subheaders (Kanban Agents Tab + Onboarding)**: Reorders the agent rows so the six default-on roles are contiguous (moving Analyst up above Acceptance Tester) and inserts "Core"/"Optional" sub-labels in both the kanban AGENTS tab and the onboarding CLI step, making the list scannable while preserving all `data-role`/id-keyed wiring.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. Every change is self-contained within this feature's files; nothing external must land first.
- **Shipping order within this feature:** The four subtasks are independent and can land in any order. Two benign shared surfaces are worth noting for whoever codes them:
  - *Worktree tooltip* and *Core/Optional subheaders* both edit `src/webview/kanban.html`, but in disjoint regions — `updateCreateWorktreeButton()`/tooltip overlay (`~3898-3960`, `~5566-5600`) vs the AGENTS tab and `<style>` block (`~1168-1253`, `~2834-2880`). No merge conflict of substance; if applied as separate patches, expect line-number drift only.
  - *Claudify live-apply* and *American "color"* both concern the `colourKanbanIcons` setting but never touch the same lines: the former edits `TaskViewerProvider.ts` (backend broadcast) using the identifier `colourKanbanIconsChanged`/`getEffectiveColourKanbanIcons`; the latter edits only display copy in `setup.html`/`package.json` and explicitly preserves those exact identifiers. They are compatible and order-independent.
- **Prerequisites / guards:** The hard guard shared across the set is *do not rename any `colour`-spelled identifier* (config key `switchboard.theme.colourKanbanIcons`, message types, body class `kanban-icons-colour`, function `getEffectiveColourKanbanIcons`, DOM ids) — the American-spelling subtask changes display copy only, and the live-apply subtask depends on those identifiers staying British.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Create Worktree Button Has No Tooltip When Active](../plans/feature_plan_20260709124500_create-worktree-button-tooltip-when-active.md) — **CODE REVIEWED**
- [ ] [Claudify "Colour Kanban Board Icons" Not Applied Live When Switching to Claudify](../plans/feature_plan_20260709124600_claudify-colour-kanban-icons-live-apply-on-theme-switch.md) — **CODE REVIEWED**
- [ ] ["Colour Kanban Board Icons" Label & Description Should Use American "Color"](../plans/feature_plan_20260709124700_colour-kanban-icons-american-spelling.md) — **CODE REVIEWED**
- [ ] [Agents List Needs "Core" / "Optional" Subheaders (Kanban Agents Tab + Onboarding)](../plans/feature_plan_20260709124800_agents-tab-core-optional-subheaders.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Completion Report

Implemented all four UI-polish subtasks. In `src/webview/kanban.html`, `updateCreateWorktreeButton()` now sets descriptive `data-tooltip` text in its enabled states, the AGENTS tab rows were reordered into Core/Optional groups with `.agents-group-label` subheaders, and the corresponding style was added. In `src/services/TaskViewerProvider.ts`, the `switchboard.theme.name` config watcher now broadcasts `colourKanbanIconsChanged` with the effective value from `getEffectiveColourKanbanIcons()`, making Claudify icon coloring apply live. In `src/webview/setup.html` and `package.json`, the user-facing title and description were changed from "colour" to "color" while leaving the config key and all internal identifiers unchanged. In `src/webview/implementation.html`, the onboarding CLI step also received the Core/Optional grouping and matching style. The first `Core` label was given an inline `margin-top:4px` because the planned `:first-of-type` rule would not match due to preceding header/intro `div` elements. No tests or compilation steps were run per the session directive; verification was by reading modified files and grep checks.

