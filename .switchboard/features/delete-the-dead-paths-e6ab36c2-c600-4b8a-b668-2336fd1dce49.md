# Delete the Dead Paths

<!-- board-collapse-membership -->
> **MEMBERSHIP CORRECTED 2026-09-04 (Board Collapse audit). Two subtasks, not three.**
> 
> The Goal paragraph was corrected when *Remove Retired-Mode UI Notices* was moved to Completed (it landed 2026-08-24 in `a42cad1f`), but **its bullet in the body was not removed**. That bullet describes delivered work as pending. The banner and the surviving two bullets are correct.


**Complexity:** 2

## Goal

Remove two code paths that serve nothing. (Corrected 2026-09-04, Board Collapse 01: this feature described three. The third, *Remove Retired-Mode UI Notices*, was **delivered on 2026-08-24 in commit `a42cad1f`** during the reviewer pass on the Mission Control feature; its card has been detached from this feature and moved to Completed.) A tickets ask-agent verb whose button was removed when collaboration moved to local markdown files; nine file-resolution fallbacks pointing into a singular dot-agent directory at locations that never held the files they name, with the four legitimate migration sites left intact;. Two pure removals, verifiable the same way.

## How the Subtasks Achieve This

- **Remove the dead tickets ask-agent path** — deletes the verb and its webview helper; the button it served went away when ticket collaboration moved to downloading tickets as local markdown files.
- **Delete the dead dot-agent singular fallback paths, keep the migration** — removes nine runtime file-resolution fallbacks pointing at locations that never held the files they name, leaving the four sites that legitimately migrate.
- **Remove retired-mode UI notices** — deletes the permanent banner announcing the retirement of a mode that was never released, plus two similar dynamic notice renderings.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Delete the dead `.agent/` fallback paths, keep the `.agent/` migration](../plans/remove-dead-agent-singular-fallback-paths.md) — **CREATED** — ID: a7a89fa3-a4d0-43e0-b8d6-2171e1dbfcfe
- [ ] [Remove the dead tickets ask-agent path](../plans/remove-dead-tickets-ask-agent-path.md) — **CREATED** — ID: bb3d0ad8-7094-40ca-adc2-2ed74ac9f71e
<!-- END SUBTASKS -->

## Dependencies & sequencing

No ordering constraints; three independent deletions. Grouped because they are all pure removals with the same verification shape — confirm no live caller, delete, confirm the gates stay green — so one pass covers all three.

