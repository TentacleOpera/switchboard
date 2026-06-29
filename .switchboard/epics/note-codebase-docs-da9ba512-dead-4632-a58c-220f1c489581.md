---
description: 'Note codebase docs'
---

# Note codebase docs

> Phase 2 of the Remote Planning Infrastructure epic (`epic-remote-planning-infrastructure-7421946e-...`), split out as its own epic.

## Goal

Continuously sync the workspace's codebase documentation into Notion so a remote claude.ai + Notion session can read the code and author a code-grounded plan **with no repo access, no GitHub MCP, and no git branches**. The extension keeps a "Switchboard Codebase Docs" Notion database current; the remote agent reads it, writes a plan into the plans DB with the trigger column, and the shipped `RemoteControlService` + Phase-1 startup reconciler dispatches it locally.

### Problem & Background

Today remote agents have zero repo access — `switchboard_remote_notion.md` treats the plan-card text as the sole source of truth, and the PRD/constitution are local-only (`prdUtils.ts:33-36`). The only repo-summarizing code, `ContextBundler.bundleWorkspaceContext()` (`ContextBundler.ts:64-219`), emits DOCX for *manual* Google NotebookLM upload — local-only, not page-structured, not synced. This epic re-targets that walker to markdown and pushes it into Notion incrementally.

### Root cause / corrected assumptions

- Notion writes already auto-retry with `Retry-After` (`NotionFetchService.httpRequest` 74-117) — no new backoff engine needed.
- Incremental sync already exists for inbound docs (`imported_docs` content-hash pattern, `KanbanDatabase.ts:280-303` + `PlanningPanelProvider` 7605-7650) — Phase 2 mirrors it outbound.
- Page write primitives already exist (`createPage` 678-751, `updatePageContent` 631-672).

## Child plans (all specified — Notion-only for v1)

- **1/4 — `phase2-codebase-doc-generator.md`** (Cplx 5): reuse `ContextBundler`'s walker to emit a structured markdown doc set (overview → module → file) with stable slugs + content hashes. Pure local transform.
- **2/4 — `phase2-notion-codebase-docs-sync.md`** (Cplx 6): new "Switchboard Codebase Docs" Notion DB + incremental push (hash diff → push only changed, archive deleted). New `codebase_docs_sync` table.
- **3/4 — `phase2-codebase-docs-sync-triggers-and-ui.md`** (Cplx 5): triggers (manual / on-commit via the Airlock hook / optional timer) + Remote-tab config & status UI. Off by default.
- **4/4 — `phase2-remote-plan-from-notion-docs.md`** (Cplx 2): orient the claude.ai + Notion agent to read the docs DB and author code-grounded plans with zero repo access. Folds into the Notion remote skill.

## Resolved design decisions

- **Granularity:** per-file pages under per-directory module parents + a repo-root overview (not per-symbol, not one-giant-doc).
- **Rate limits:** serialized ~350 ms queue on top of the existing `Retry-After` retry; hash diff keeps steady-state syncs to a handful of pages.
- **Base:** reuse `ContextBundler` walk + file-summary extraction (factored into shared helpers); DOCX/NotebookLM flow untouched.
- **Sync-state:** `codebase_docs_sync` table (slug + `content_hash` + `notion_page_id` + `last_synced_at`).
- **Scope:** Notion-only for v1; Linear/ClickUp codebase-doc sync is an explicit follow-on.

## Sequencing

Phase 1 (remote plan improvement + startup reconciler) has no dependency on this epic — land it first, then this. Within this epic: 1/4 → 2/4 → 3/4 → 4/4.

