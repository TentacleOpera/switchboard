---
description: 'Auto-Archive & Production Hardening'
---

# Auto-Archive & Production Hardening

**Plan ID:** fbda9869-e114-4e4d-8a12-b81f5af5d64b

**Complexity:** 5

**Coordination contract:** [Remote Control Production Readiness — Cross-Epic Sequencing & Coordination Plan](../plans/feature_plan_20260701_remote-control-production-sequencing.md) — **epic 7 of 7** in the program dispatch order (last by design; see the contract's cross-epic seams for the overwrite-guard handshake with epic 2 and the pre-release pull-forward rule for the hide-triage card).

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
- [ ] [Switchboard Auto-Archive Rule (Time-in-Column → Completed + Archive)](../plans/linear-free-tier-auto-archive-on-completion.md) — **CODE REVIEWED**
- [ ] [Notion Overwrite Data-Loss Guard (Code-Level)](../plans/notion-overwrite-guard.md) — **CODE REVIEWED**
- [ ] [Remote-Sync Health & Error Surfacing](../plans/remote-sync-health-surfacing.md) — **CODE REVIEWED**
- [ ] [Hide Triage Pipeline + Kanban Mapping/Automation Setup Sections (Pre-Release UI Gate)](../plans/hide-triage-and-automation-setup-sections.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Review Findings

All 4 subtasks reviewed in-place against their plan requirements. No CRITICAL findings. One MAJOR finding (auto-archive dwell timer uses `updatedAt` instead of a dedicated `columnEnteredAt` field — schema limitation, not a code bug). All NITs are documented in the respective subtask plan files. No code fixes were required — all implementations are sound against their plan criteria. The epic's cross-cutting contracts are honored: the overwrite guard is consumed by `pushProjectContext` and `updatePageContent`; the auto-archive rule rides the `archiveCard` provider capability; health surfacing integrates with both the poll loop and the push paths (auto-archive + project-context sync).
