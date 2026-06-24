# Split Constitution Tab: Move CLAUDE.md & AGENTS.md into a "System" Tab

## Goal

The `project.html` **Constitution** tab currently conflates three distinct things into one messy view: the project constitution, `CLAUDE.md`, and `AGENTS.md`. Split them so the Constitution tab shows **only** the project constitution, and create a new **System** tab that houses `CLAUDE.md` and `AGENTS.md`.

### Problem Analysis

The Constitution tab was meant to display the project's constitution (the user-authored project rules). Over time it grew to also surface `CLAUDE.md` and `AGENTS.md` — agent-configuration files that are conceptually "system/agent instructions", not "project constitution". Jamming all three into one tab makes the tab look terrible and makes it hard to find or edit the right file. They serve different audiences (constitution = project rules for humans/agents; CLAUDE.md/AGENTS.md = agent runtime configuration) and should be separated.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, refactor

## Complexity Audit

### Routine
- Add a new "System" tab to the `project.html` tab bar.
- Move the `CLAUDE.md` and `AGENTS.md` rendering/editing UI out of the Constitution tab and into the System tab.
- Trim the Constitution tab to show only the project constitution.

### Complex / Risky
- The tab system in `project.html` may use shared rendering/editing infrastructure (load, save, dirty-state tracking) that CLAUDE.md/AGENTS.md/constitution all use. Moving the two files to a new tab must preserve their load/save/edit behaviour.
- If the Constitution tab currently uses a single combined data load, splitting may require separate data fetches or a shared load that feeds both tabs.
- Tab state (active tab, dirty indicators) must account for the new tab.

## Edge-Case & Dependency Audit

- **Tab persistence:** If the active tab is persisted, ensure the new System tab is a valid persisted value and old persisted values still resolve.
- **Empty states:** A project with no constitution vs. no CLAUDE.md/AGENTS.md — each tab should handle its own empty state gracefully.
- **Backend:** If the backend serves these files via distinct endpoints, the new tab can reuse them; if it serves a combined payload, verify the split still works.
- **No data migration** — this is a UI reorganisation, not a data format change.

## Proposed Changes

### project.html — tab bar
- **Context:** The tab bar defines the visible tabs (e.g. Constitution, …).
- **Logic:** Add a "System" tab alongside the existing tabs.
- **Implementation:** Add the tab button + panel container. Wire activation/show/hide to the existing tab-switching logic.

### project.html — move CLAUDE.md & AGENTS.md UI into System tab
- **Context:** The Constitution tab currently renders constitution + CLAUDE.md + AGENTS.md sections.
- **Logic:** Move the CLAUDE.md and AGENTS.md sections (rendering, editing, save handlers) into the new System tab panel.
- **Implementation:** Relocate the relevant DOM blocks and their associated JS handlers/listeners into the System tab. Ensure load/save still fires correctly when the System tab is shown.
- **Edge Cases:** Preserve any per-file dirty-state tracking and save indicators.

### project.html — Constitution tab cleanup
- **Context:** After the move, the Constitution tab should show only the project constitution.
- **Logic:** Remove the CLAUDE.md/AGENTS.md sections from the Constitution tab panel.
- **Implementation:** Delete the relocated DOM and any now-dead handler references. Verify the constitution load/render still works.

## Verification Plan

- [ ] Constitution tab shows only the project constitution.
- [ ] System tab shows CLAUDE.md and AGENTS.md with working view/edit/save.
- [ ] Switching between tabs preserves dirty state per file.
- [ ] Empty-state for a project with no constitution / no CLAUDE.md / no AGENTS.md renders correctly in the respective tab.
- [ ] No dead references to the moved sections remain in the Constitution tab.
