# Prompts tab git strategy UX cleanup

**Complexity:** 4

## Goal

Two related issues with the Prompts tab git strategy UI: (1) add-ons render as a flat dump with no grouping — git Branch/Commit/Push radios sit inline with unrelated checkboxes, page is too long, option descriptions hidden in hover tooltips; (2) git strategy defaults are opinionated (current/whenDone/noPush) emitting a full GIT POLICY block even when the user never chose a strategy, and the Incremental Commits option is not meaningfully different from Commit When Done.

## How the Subtasks Achieve This

- **Prompts tab layout — group ungrouped prompts first, make git subsections accordions, add option descriptions**: Adds a group field to the git radio definitions in sharedDefaults.js so the renderer can partition addons into general (first) and named subsections. Refactors renderRoleAddons() to render each git strategy radio group as a collapsed accordion, and surfaces option tooltip text as visible helper text beneath each label.
- **Git strategy defaults should be Not Specified for all three; remove meaningless Incremental Commits option**: Changes all five hardcoded default sites (radio definitions, DEFAULT_ROLE_CONFIG, custom-agent fallback, server-side merge fallback, per-role override fallbacks) from prescriptive values (current/whenDone/noPush) to notSpecified, and removes the incremental commit option from the radio options, type union, and clause vocabulary.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix: Prompts tab layout — group ungrouped prompts first, make git subsections accordions, add option descriptions](../plans/feature_plan_20260707125810_prompts-tab-layout-accordions-grouping.md) — **LEAD CODED**
- [ ] [Fix: Git strategy defaults should be "Not Specified" for all three; remove meaningless "Incremental Commits" option](../plans/feature_plan_20260707125920_git-strategy-defaults-notspecified-remove-incremental.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraint — both plans edit the same sharedDefaults.js radio objects but different fields (group vs default/options). The plans explicitly note no conflict — different fields of the same objects. Coordinate merge order so both land cleanly. Subtasks can be executed in parallel.
