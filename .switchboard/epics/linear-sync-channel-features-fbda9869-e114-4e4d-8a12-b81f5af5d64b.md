---
description: 'Auto-Archive & Production Hardening'
---

# Auto-Archive & Production Hardening

**Plan ID:** fbda9869-e114-4e4d-8a12-b81f5af5d64b

**Complexity:** 5

> Formerly "Linear Sync & Channel Features." Rescoped per the remote-control production decisions: the Linear **channel-issues / analyst chat** plan is **cut** (not needed); Linear **bidirectional description sync** moved into the Remote Sync Refactor trunk as a push capability; the auto-archive plan was **reframed from a Linear feature into a Switchboard-level rule**. This epic now owns the two production concerns no other epic covered.

## Goal

Ship the operational safeguards that make remote control safe to run on the primary user surface across ~4,000 installs with **no feature flag**: an extension-level auto-archive rule, a hard code-level guard against destructive Notion writes, and user-visible remote-sync health.

## How the subtasks achieve this

- **Switchboard Auto-Archive Rule (time-in-column → Completed + archive)**: a kanban.html setup rule — after a configurable dwell in a **designated** column (default = the stage before Completed), a plan auto-moves to Completed and archives; Linear/Notion follow via push. Solves the real "900 stuck plans vs. Linear free-tier cap" problem by automating the move itself; the trigger column is designated, not hardcoded, so it tracks board topology (e.g. a PRD-tester stage inserted before Completed).
- **Notion Overwrite Data-Loss Guard (code-level)**: enforce append-by-default; full `replace_content` only after a verified "no inline children" check. Protects the irreversible Notion body-write path used by content push, `/improve-remote-plan`, and project-context sync.
- **Remote-Sync Health & Error Surfacing**: surface last poll/push status, rate-limit/backoff state, and persistent-failure indicators in the Remote tab (project.html) — replacing today's console-only failures.

## Dependencies & sequencing

- Auto-archive + content-write paths depend on the unified push seam (Remote Sync Refactor 1/3, `archive` capability) + Notion push (2/3).
- Health surfacing depends on the Remote tab living in `project.html` (Project Context Hub epic).
- The Notion overwrite guard is a prerequisite for high-fidelity Notion content push and project-context sync.
- See `feature_plan_20260701_remote-control-production-sequencing.md`.

## Metadata

**Complexity:** 5
**Tags:** backend, ui, ux, reliability, security, api, feature

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Switchboard Auto-Archive Rule (Time-in-Column → Completed + Archive)](../plans/linear-free-tier-auto-archive-on-completion.md) — **PLAN REVIEWED**
- [ ] [Notion Overwrite Data-Loss Guard (Code-Level)](../plans/notion-overwrite-guard.md) — **PLAN REVIEWED**
- [ ] [Remote-Sync Health & Error Surfacing](../plans/remote-sync-health-surfacing.md) — **PLAN REVIEWED**
- [ ] [Hide Triage Pipeline + Kanban Mapping/Automation Setup Sections (Pre-Release UI Gate)](../plans/hide-triage-and-automation-setup-sections.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
