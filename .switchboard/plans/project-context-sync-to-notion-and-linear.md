# Project-Context Sync — project.html Content → Notion + Linear

**Plan ID:** f66ade21-bce8-4dae-935c-b738107d3c5a

## Goal

Sync **all `project.html` content** — Dev Docs + project PRDs + workspace constitution — outward to **Notion and Linear**, provider-agnostically, so a remote agent (claude.ai + Notion, or Linear-native) reads real, current planning context instead of "post-it notes." Switchboard is the source of truth; the providers receive a mirror.

### Problem & background

Constitution and PRDs are local-only today (`prdUtils.ts`), and there is no dev-docs concept at all until the Dev Docs tab lands (`project-html-dev-docs-tab-and-ia.md`). A remote planning session therefore has no curated context. The fix is **not** a codebase-mirroring pipeline (explicitly cut) — it is syncing the small, curated set of project-context documents that already (or will) live in `project.html`.

### Provider-agnostic by design

Context is a **project-level** target, distinct from per-card remote control:
- **Notion:** a project page / context area.
- **Linear:** the project's description / documents.

Both ride the **unified push seam** delivered by Remote Sync Refactor 1/3 (which declares a project-level entity, not just issue-level). Do not build a separate Notion-only pipeline.

## What gets built

1. A **project-context push** that, on change (or on demand), writes the current Dev Docs + PRDs + constitution to the configured Notion project page and Linear project docs, via the unified push dispatch's project-level capability.
2. **Change detection** coarse enough to respect rate limits — a cheap "has project context changed at all?" gate before pushing (Notion ≈ 3 req/s is the binding constraint; the existing `NotionFetchService.httpRequest` `Retry-After` retry covers transient 429s). No per-page content-hash machinery (that was the cut incremental design).
3. **Remote-tab controls** (in the relocated Remote tab, `project.html`) to enable/trigger the sync and show last-sync status.

## Critical: Notion overwrite safety

Writing context to a Notion page must obey the **Notion overwrite guard** (`notion-overwrite-guard.md`): append-by-default; full `replace_content` only after verifying the page has no inline children. A project page is exactly the kind of page likely to hold nested content — a blind overwrite permanently orphans sub-pages and breaks block IDs.

## Dependencies & sequencing

- Depends on the **Dev Docs tab** (`project-html-dev-docs-tab-and-ia.md`) for the content surface.
- Depends on the **unified push seam** (Remote Sync Refactor 1/3) declaring a project-level target, and on **Notion push** (2/3).
- Depends on the **Notion overwrite guard** (`notion-overwrite-guard.md`).
- Consumed by remote-agent orientation (`phase2-remote-plan-from-notion-docs.md`), which teaches the agent to read this context.

## Metadata

**Complexity:** 5
**Tags:** backend, api, feature, reliability, ui
**Repo:** switchboard
