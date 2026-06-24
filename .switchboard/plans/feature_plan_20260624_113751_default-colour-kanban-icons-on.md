# Default "Colour Kanban Board Icons" to ON for Claudify & Afterburner Professional

## Goal

In `setup.html`, the Theme tab exposes a "Colour kanban board icons" toggle. For the **Claudify** and **Afterburner Professional** themes, this toggle currently defaults to **OFF**. It should default to **ON** instead, so that users selecting either of those themes immediately see coloured kanban icons without having to manually enable the option.

### Problem Analysis

The "Colour kanban board icons" setting controls whether kanban board card icons are rendered in colour (theme accent) or monochrome. The default value is determined per-theme (or via a single global default that the theme selection overrides). For Claudify and Afterburner Professional — both "professional" themes with neutral chrome — coloured icons are the intended visual default, but the current code leaves them off, producing a drabber board than expected and forcing the user to discover and flip the toggle.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, ux, bug

## Complexity Audit

### Routine
- Locate the default value logic for the "Colour kanban board icons" toggle in `setup.html` (likely in the theme-selection change handler or the setting initialisation).
- Change the default for `claudify` and `afterburner-professional` to ON.

### Complex / Risky
- If the default is driven by a persisted setting rather than a per-theme fallback, the change must only affect the *unset* (first-use) case — users who have already explicitly toggled it should keep their choice.

## Edge-Case & Dependency Audit

- **Existing users:** Users who already have an explicit value persisted should not have it overridden. The default change only applies when no value is stored.
- **Afterburner (plain):** Unchanged — should remain whatever it currently is (presumably OFF or unchanged).
- **No backend changes** — this is a UI default value change only.

## Proposed Changes

### setup.html — toggle default
- **Context:** The Theme tab includes a "Colour kanban board icons" checkbox/toggle bound to a setting (likely `switchboard.colourKanbanIcons` or similar).
- **Logic:** When the user selects `claudify` or `afterburner-professional` and no explicit value is persisted, the toggle should default to ON.
- **Implementation:** Find the theme-selection change handler and/or the setting initialisation block; add per-theme default logic so claudify and afterburner-professional set the default to `true` when the setting is unset.
- **Edge Cases:** Afterburner (plain) keeps its current default. Already-persisted explicit values are respected.

## Verification Plan

- [ ] Select Claudify theme from a clean state → toggle shows ON, kanban icons are coloured.
- [ ] Select Afterburner Professional from a clean state → toggle shows ON, kanban icons are coloured.
- [ ] Select Afterburner (plain) → toggle default unchanged.
- [ ] Manually toggle OFF, switch away and back → persisted OFF value is respected (not reset to ON).
