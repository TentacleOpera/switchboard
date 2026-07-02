---
description: 'Project Context & Remote UI Hub'
---

# Project Context & Remote UI Hub

**Plan ID:** da9ba512-dead-4632-a58c-220f1c489581

**Complexity:** 5

**Coordination contract:** [Remote Control Production Readiness — Cross-Epic Sequencing & Coordination Plan](../plans/feature_plan_20260701_remote-control-production-sequencing.md) — **epic 1 of 7** in the program dispatch order.

> Formerly "Note codebase docs." Rescoped per the remote-control production decisions: **no codebase code-mirroring.** The remote agent gets curated **developer docs + PRDs + constitution**, authored in `project.html` and synced provider-agnostically to Notion + Linear.

## Goal

Make `project.html` the single **project-context hub** and give the remote agent real planning context — so remote plans are code-grounded, not "post-it notes" that make execution agents do wrong work.

### Problem & background

A remote claude.ai + Notion (or Linear-native) session has zero repo access and no curated context today; constitution + PRDs are local-only (`prdUtils.ts`) and there is no dev-docs concept at all. The earlier Phase-2 answer over-engineered this into a code-mirroring pipeline (repo-walker generator → per-file Notion pages → incremental hash-diff sync). That is **cut**. The right answer: a **Dev Docs tab** in `project.html`, and **all** `project.html` content synced to both trackers.

The context pipeline: **NotebookLM (get code into an analysis system) → author Dev Docs → Dev Docs + PRDs + constitution sync to Notion/Linear → remote agent reads real context.** NotebookLM is the on-ramp, so it moves into `project.html` alongside Dev Docs and the Remote tab.

## How the subtasks achieve this

- **Project Context Hub — Dev Docs Tab + project.html IA** *(STEP 0 of the program)*: add a Dev Docs tab; move the Remote tab and the NotebookLM tab (from planning.html) into `project.html`. Gates the Remote Sync Refactor 3/3 UI phase so Remote-tab UX is built in its final home.
- **Project-Context Sync — project.html Content → Notion + Linear**: sync Dev Docs + PRDs + constitution outward via the unified push seam's project-level capability (not a Notion-only pipeline). Obeys the Notion overwrite guard.
- **Remote Agent Orientation — Plan From Project-Context Docs**: orient the single remote skill to read the synced context and author code-grounded plans with no repo access (provider-agnostic; supersedes the codebase-docs orientation).
- **Linear Remote Tab: Dynamic Agent Skill Copy Button**: a Remote-tab (now in project.html) button that generates tailored orientation text for Linear's native agent.

## Dependencies & sequencing

- STEP 0 (Dev Docs + IA) first — gates Remote Sync Refactor 3/3's UI phase.
- Context sync depends on the unified push seam (Remote Sync Refactor 1/3) + Notion push (2/3) + the Notion overwrite guard.
- See `feature_plan_20260701_remote-control-production-sequencing.md`.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, ux, backend, api, docs, feature

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Linear Remote Tab: Dynamic Agent Skill Copy Button](../plans/linear-remote-agent-skill-copy-button.md) — **CODER CODED**
- [ ] [Remote Agent Orientation — Plan From Project-Context Docs (No Repo)](../plans/phase2-remote-plan-from-notion-docs.md) — **CODER CODED**
- [ ] [Project Context Hub — Dev Docs Tab + project.html Information Architecture](../plans/project-html-dev-docs-tab-and-ia.md) — **CODER CODED**
- [ ] [Project-Context Sync — project.html Content → Notion + Linear](../plans/project-context-sync-to-notion-and-linear.md) — **CODER CODED**
<!-- END SUBTASKS -->
