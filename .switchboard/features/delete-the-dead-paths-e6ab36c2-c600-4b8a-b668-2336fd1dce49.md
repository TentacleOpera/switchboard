# Delete the Dead Paths

**Complexity:** 2

## Goal

Remove three code paths that serve nothing. A tickets ask-agent verb whose button was removed when collaboration moved to local markdown files; nine file-resolution fallbacks pointing into a singular dot-agent directory at locations that never held the files they name, with the four legitimate migration sites left intact; and a permanent banner announcing the retirement of a mode that was never released. Three pure removals, verifiable the same way.

## How the Subtasks Achieve This

- **Remove the dead tickets ask-agent path** — deletes the verb and its webview helper; the button it served went away when ticket collaboration moved to downloading tickets as local markdown files.
- **Delete the dead dot-agent singular fallback paths, keep the migration** — removes nine runtime file-resolution fallbacks pointing at locations that never held the files they name, leaving the four sites that legitimately migrate.
- **Remove retired-mode UI notices** — deletes the permanent banner announcing the retirement of a mode that was never released, plus two similar dynamic notice renderings.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Delete the dead `.agent/` fallback paths, keep the `.agent/` migration](../plans/remove-dead-agent-singular-fallback-paths.md) — **CREATED**
- [ ] [Remove the dead tickets ask-agent path](../plans/remove-dead-tickets-ask-agent-path.md) — **CREATED**
- [ ] [Remove Retired-Mode UI Notices](../plans/remove-retired-mode-ui-notices.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No ordering constraints; three independent deletions. Grouped because they are all pure removals with the same verification shape — confirm no live caller, delete, confirm the gates stay green — so one pass covers all three.

