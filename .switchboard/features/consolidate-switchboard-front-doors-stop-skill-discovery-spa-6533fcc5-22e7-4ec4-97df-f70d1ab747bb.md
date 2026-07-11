# Consolidate Switchboard Front Doors & Stop Skill-Discovery Spam

**Complexity:** 7

## Goal

Reduce Switchboard's user-facing entry points to a coherent minimal surface and eliminate the background-skill slash-command spam that filesystem-scanning hosts (Antigravity, Devin, Cowork) introduced once every skill was given discovery frontmatter. First strip the discovery frontmatter from background skills so they stop cluttering the menu while staying reachable by reference, then consolidate the front doors to a single adaptive /switchboard plus /memo, with a dedicated Setup-exported switchboard-cowork skill for Cowork.

## How the Subtasks Achieve This

- **Stop Skill-Discovery Spam in Antigravity & Devin by Removing Source Frontmatter**: Removes the `name`+`description` YAML frontmatter from the background-skill `.agents/skills/*/SKILL.md` sources — the exact addition that made filesystem-scanning hosts auto-register every skill — while preserving Claude Code's mirror output by moving each description into `MIRROR_MANIFEST.descriptionFallback`. This directly ends the slash-menu spam and restores "reached by explicit reference" as the way background skills are used.
- **Collapse Switchboard Front Doors to a Single Adaptive `/switchboard` (Plus `/memo`)**: Consolidates the overlapping entry points into one environment-adaptive `/switchboard` (local→management-console hub, cloud→plan-mode brake) plus the standalone `/memo`, folds `switchboard-chat`/`switchboard-manage` into internal routed skills, ships a dedicated `switchboard-cowork` skill via a Setup-panel export button, and drops `switchboard-mcp` to a transport layer. This delivers the coherent minimal surface the goal calls for.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Stop Skill-Discovery Spam in Antigravity & Devin by Removing Source Frontmatter](../plans/fix-skill-discovery-frontmatter-spam.md) — **LEAD CODED**
- [ ] [Collapse Switchboard Front Doors to a Single Adaptive `/switchboard` (Plus `/memo`)](../plans/consolidate-switchboard-front-doors.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Sequence is fixed: **Plan 1 (frontmatter strip) must land before Plan 2 (front-door redesign).** Plan 2's demotions of `switchboard-chat`, `switchboard-manage`, and `switchboard-mcp` rely on Plan 1's frontmatter-strip + `descriptionFallback` mechanism already being in place. Plan 1 is independently shippable and delivers the spam fix on its own; Plan 2 builds the identity/consolidation on top.

---

## Feature Completion Summary

Both subtasks implemented in sequence. **Plan 1** stripped YAML frontmatter from all 32 `.agents/skills/*/SKILL.md` directory sources and backfilled `descriptionFallback` on every `MIRROR_MANIFEST` entry (including all shared-source aliases) so Claude Code mirror output stays byte-equivalent — ending the Antigravity/Devin slash-menu spam. **Plan 2** collapsed the front doors to a single adaptive `/switchboard` (3-way environment detection + live health check + plan-mode safe fallback, friendly opener preserved) plus `/memo`, demoted `switchboard-chat`/`switchboard-manage`/`switchboard-mcp`/verb aliases to internal `no-user` skills, shipped a dedicated `switchboard-cowork` skill via a Setup-panel "Set up Cowork" `.zip` export button, and updated `AGENTS.md`/manual/preamble to the two-door surface. No issues encountered; compilation and tests skipped per session directive.
