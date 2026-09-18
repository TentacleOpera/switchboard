# Project Context Hub — Dev Docs Tab + project.html Information Architecture

**Plan ID:** 797aeb2d-ba47-43d8-a0b7-dba20b2048e0

## Goal

Make `project.html` the single **project-context hub**: add a **Dev Docs** tab, and relocate the **Remote** tab and the **NotebookLM** tab (currently in planning.html) into it. This is **STEP 0** of the remote-control program — it must land before the Remote Sync Refactor's UI phase (3/3), so that phase builds the Remote-tab UX in its final home rather than building it in the old location and moving it.

### Problem & background

Project context is scattered: the Remote tab lives outside project.html, NotebookLM lives in planning.html, and there is no place to author developer docs at all. Yet these three belong to one workflow:

> **NotebookLM (get code into an analysis system) → author Dev Docs → Dev Docs + PRDs + constitution sync out to Notion/Linear → remote agent reads real context.**

NotebookLM is the on-ramp that produces dev docs; dev docs are the authored context; the Remote tab is where that context (and control) flows out. Co-locating them in `project.html` makes the pipeline legible and gives the sync work (see `project-context-sync-to-notion-and-linear.md`) a single source surface.

Root cause of the "post-it notes" problem this addresses: today a remote claude.ai + Notion session has zero repo access and no curated context, so it authors shallow plans — and a shallow plan makes execution agents do wrong work. The Dev Docs tab is where a human captures the curated developer context that fixes this. **This is not code-mirroring** — the cut `phase2-codebase-doc-generator` / per-file Notion pages / `codebase_docs_sync` hash-diff pipeline are explicitly out of scope.

## What gets built

1. **Dev Docs tab** in `project.html` — an authoring/edit surface for developer documentation, stored per-workspace alongside the existing PRD/constitution storage (`prdUtils.ts` is the existing local-only PRD/constitution home; Dev Docs sits with it). No confirmation dialogs (house rule).
2. **Relocate the Remote tab** into `project.html` from its current home. Behavior unchanged; only the containing webview changes. The Remote Sync Refactor 3/3 Ingest/Full UX + push controls + sync-health surfacing target this relocated tab.
3. **Relocate the NotebookLM tab** from `planning.html` into `project.html`, adjacent to Dev Docs. The DOCX/NotebookLM export flow (`ContextBundler.bundleWorkspaceContext`) is untouched — only the tab's location moves.

## Edge cases & migration

- These are **webview relocations**; the per-workspace settings behind each tab are storage-keyed, not webview-keyed, so no data migration is required. Verify: NotebookLM/ContextBundler state, any "active tab" persistence, and the Remote tab's config all resolve in the new host.
- Confirm no planning.html code paths hard-depend on the NotebookLM tab being in planning.html (event wiring, message routing).
- Published-extension note: if any released version persisted "last active tab" per webview, preserve/whitelist unknown tab keys rather than dropping them.

## Sequencing

**Gates the Remote Sync Refactor 3/3 UI phase.** Lock this IA first. See `feature_plan_20260701_remote-control-production-sequencing.md`.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, ux, refactor
**Repo:** switchboard

## Review Findings

Reviewed against the implemented commits (d3f41be, 6c5297d, d42c6e3, 03fb102). The Dev Docs tab, Remote-tab relocation, and NotebookLM-tab relocation all landed in `project.html`/`project.js` with all required CSS classes (planning-card, remote-checkbox-list, etc.) defined in the new host. Path-traversal protection on dev-doc paths (`_resolveDevDocPath`), workspace persistence for NotebookLM (`notebook.root` survives the move via `notebookDefaultRoot`), and kanban toolbar toggle hydration (`getRemoteConfig` at boot) are all correct. No orphaned references remain in `kanban.html`/`planning.js`. One NIT: `_handleAirlockExport` was activated from a "coming soon" stub to call `bundleWorkspaceContext` — positive scope expansion beyond "relocation only" but low risk. No CRITICAL/MAJOR findings; no code changes required for this plan.
