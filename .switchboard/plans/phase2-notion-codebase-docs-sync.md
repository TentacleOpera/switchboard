# Phase 2 (2/4): Notion Codebase-Docs Database + Incremental Push Pipeline

## Goal

Create a dedicated **"Switchboard Codebase Docs"** Notion database and an **incremental push pipeline** that takes the `CodebaseDocSet` produced by plan 1/4 and mirrors it into Notion — creating/updating only the pages whose content changed since the last sync, deleting pages for files that no longer exist, and respecting Notion's rate limits. This is what makes a no-repo claude.ai + Notion planning session possible: the codebase lives in Notion as navigable pages.

### Problem & Background

Plan 1/4 generates an in-memory doc set; it has nowhere to go. The extension can already write pages to Notion (`NotionFetchService.createPage()` `678-751`, `updatePageContent()` `631-672`) and already creates managed databases (`NotionBackupService.autoCreateDatabase()` `165-231`), but **there is no codebase-docs database, no push pipeline, and no per-doc sync-state for exported docs.** Every existing Notion plan push is an *unconditional full re-push* (`NotionBackupService._upsertPlanToNotion` line 418 PATCHes unconditionally; plans table has no content hash). Re-pushing an entire codebase every cycle would burn the rate budget instantly (Notion ≈ 3 req/s).

### Root Cause / Correction to the epic's assumptions

The epic flagged two "unknowns" that the codebase already answers:
1. **"Notion does NOT auto-retry" — FALSE.** `NotionFetchService.httpRequest()` (lines 76–117) already implements up to 3 attempts with `Retry-After` parsing (capped 5 s) and exponential-backoff fallback, plus a 200 ms inter-call delay (`336/344`). The pipeline builds on this; it does not add a second retry engine.
2. **"Need sync-state tracking from scratch" — PARTLY FALSE.** The `imported_docs` table (`KanbanDatabase.ts:280-303`) + the content-hash conflict logic in `PlanningPanelProvider` (`7854-7897`) and `updateLastSynced(slug, hash, workspaceId)` in `PlanningPanelCacheService.ts:441` is the exact incremental-sync pattern needed — it is just pointed *inbound* (remote → local) today. Phase 2 needs the *outbound* mirror of that pattern. We add a parallel `codebase_docs_sync` table rather than overloading `imported_docs` (different lifecycle: generated-and-pushed vs. imported-and-pulled).

## Metadata

**Complexity:** 6
**Tags:** backend, feature, database, api
**Depends on:** `phase2-codebase-doc-generator.md` (1/4) — consumes its `CodebaseDocSet`.
**Related:** `notion-backup-epic-schema-and-remote-orientation.md` (shares the `autoCreateDatabase`/`_ensureColumnSelectOptions` PATCH pattern).
**Parent epic:** `epic-remote-planning-infrastructure-7421946e-dea1-4d2b-985d-5de52d088f4d.md`

## User Review Required

1. **Parent location for the docs DB.** Recommended: create the "Switchboard Codebase Docs" database under the **same Notion parent page** already configured for remote control (`remote.notion.setup` → the existing `notionConfig.pageId`, reused by `autoCreateDatabase` at `NotionBackupService.ts:167`), so the user manages one Notion location. Alternative: a user-specified separate page (plan 3/4 exposes the setting). Confirm the shared-page default is acceptable.

That is the only genuine product call. Everything else is decided below.

## Decisions (made, not deferred)

1. **Separate `codebase_docs_sync` table** (not reuse of `imported_docs`) — outbound docs have a distinct lifecycle and must never collide with imported-doc rows.
2. **Markdown → Notion blocks = paragraph + code-fence blocks**, chunked at 2000 chars/block, reusing the chunking already in `createPage`/`updatePageContent` (`727`, `664`). Rich markdown (tables/headings) is *not* required for code docs — a heading line + a fenced source block is sufficient and cheap. No new markdown-block parser. **Rendering note (Clarification):** a single source file larger than 2000 chars becomes N *adjacent* Notion code blocks, not one contiguous fence — Notion renders each chunk as its own bordered block. This is acceptable for v1 (the page title + `Path` property carry file identity); if remote-agent readability suffers, plan 1/4's `perFileByteCap` (default 60 KB → ~30 blocks) can be lowered. No new logic here — just an acknowledged rendering consequence.
3. **Update strategy = full-clobber per changed page** via the existing `updatePageContent()` (DELETE children + PATCH append). Code-doc pages have **no nested sub-pages or DB views**, so the destructive-overwrite caveat the epic raised for *plan* pages does **not** apply here — these are leaf pages we own and overwrite freely.
4. **Change detection = content hash.** Push a page only when its `contentHash` differs from the stored hash (or it's new). Unchanged files cost **zero** Notion calls.
5. **Deletion = soft.** A file removed from the repo → its row's tracked page is archived in Notion (`PATCH /pages/{id}` with `archived: true`) and the row deleted locally. No hard block deletes.

## What Gets Built

### 1. New table `codebase_docs_sync` — `src/services/KanbanDatabase.ts`

Mirror the `imported_docs` shape (`280-303`):

```sql
CREATE TABLE IF NOT EXISTS codebase_docs_sync (
  slug          TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  doc_kind      TEXT NOT NULL,   -- 'overview' | 'module' | 'file'
  parent_slug   TEXT,            -- module slug for files; null for overview/module
  notion_page_id TEXT,
  content_hash  TEXT,
  last_synced_at TEXT,
  PRIMARY KEY (slug, workspace_id)
);
```
Add CRUD helpers paralleling the imported-docs ones: `getCodebaseDocSyncRows(workspaceId)`, `upsertCodebaseDocSync(row)`, `deleteCodebaseDocSync(slug, workspaceId)`. Add the table to the migration/`CREATE TABLE` block alongside `imported_docs` (per CLAUDE.md migration policy: additive `CREATE TABLE IF NOT EXISTS`, no destructive change — safe for the ~4k install base).

### 2. Docs database provisioning — `src/services/NotionBackupService.ts` (new method, same file/pattern)

Add `ensureCodebaseDocsDatabase(): Promise<string>` modeled on `autoCreateDatabase` (`165-231`) + `_ensureColumnSelectOptions` (`348-365`):
- If `remote.notion.codebaseDocsDatabaseId` (new config key) exists, return it.
- Else `POST /databases` under the configured parent page with properties: `Name` (title), `Path` (rich_text), `Module` (rich_text), `Doc Kind` (select: overview/module/file), `Source Hash` (rich_text), `Updated At` (date).
- Persist the new database id to config key `remote.notion.codebaseDocsDatabaseId`.
- Idempotent; safe to call every sync (mirrors how `setupRemoteControl` re-ensures the plans DB).

### 3. Push pipeline — new `src/services/CodebaseDocsSyncService.ts`

```ts
async syncCodebaseDocs(workspaceRoot: string, docSet: CodebaseDocSet): Promise<{
  created: number; updated: number; archived: number; skipped: number; errors: number;
}>;
```
**Logic:**
1. `dbId = await notionBackup.ensureCodebaseDocsDatabase()`.
2. Load `rows = getCodebaseDocSyncRows(workspaceId)` → `Map<slug, row>`.
3. Build the desired set from `docSet` (overview + modules + files). For each desired doc:
   - **No row, or row has no `notion_page_id`:** `createPage()` under `dbId` with the doc markdown; on success `upsertCodebaseDocSync({...page id, content_hash, last_synced_at})`. → *created*.
   - **Row exists and `content_hash === doc.contentHash`:** skip (no Notion call). → *skipped*.
   - **Row exists, hash differs:** `updatePageContent(notion_page_id, markdown)` + PATCH the `Source Hash`/`Updated At` properties; update the row. → *updated*.
4. **Deletions:** any tracked slug not in the desired set → `PATCH /pages/{id}` `archived: true`, then `deleteCodebaseDocSync(slug, ...)`. → *archived*.
5. **Ordering for parent relations:** push overview first, then modules, then files (parents before children) so a future "Module" relation can resolve — same two-pass ordering principle the epic-schema plan uses. (v1 stores `parent_slug` locally and as a `Module` rich_text path; a Notion relation property is a follow-on, not required for the remote agent to navigate.)
6. **Throttle:** route every page through a single serialized queue with a minimum inter-call spacing (default 350 ms ≈ under 3 req/s), letting `NotionFetchService`'s existing `Retry-After` handling absorb bursts. No new backoff logic — just serialization + spacing.
7. Return counts (consumed by plan 3/4's UI/log).

### 4. Config keys (DB `config` table)

| Key | Purpose |
|-----|---------|
| `remote.notion.codebaseDocsDatabaseId` | The provisioned docs DB id |
| `remote.codebaseDocs.lastSyncAt` | ISO of last completed sync (for the UI/log in plan 3/4) |

(Enable/disable, target page, and frequency keys are owned by plan 3/4.)

## Key Reuse (do not reinvent)

| Reuse | Source |
|------|--------|
| Create DB + PATCH-to-extend pattern | `NotionBackupService.autoCreateDatabase` `165-231`, `_ensureColumnSelectOptions` `349-365` |
| Create page / full-clobber update / 2000-char chunking | `NotionFetchService.createPage` `678-751`, `updatePageContent` `631-672` |
| Rate-limit + `Retry-After` retry (already present) | `NotionFetchService.httpRequest` `76-117`, inter-call delay `336/344` |
| Content-hash incremental-sync pattern | `imported_docs` `KanbanDatabase.ts:280-303`; conflict logic `PlanningPanelProvider` `7854-7897`; `updateLastSynced` `PlanningPanelCacheService.ts:441` |
| Page archive (soft delete) | `PATCH /pages/{id}` `archived:true` (Notion API; same client — confirm the client accepts a body-only `{ archived: true }` PATCH to the pages endpoint before relying on it) |

## Complexity Audit

### Routine
- Additive `CREATE TABLE IF NOT EXISTS codebase_docs_sync` — mirrors the proven `imported_docs` DDL shape.
- CRUD helpers paralleling the imported-docs ones (`getCodebaseDocSyncRows`, `upsertCodebaseDocSync`, `deleteCodebaseDocSync`).
- `ensureCodebaseDocsDatabase()` modeled on the existing `autoCreateDatabase` + `_ensureColumnSelectOptions` PATCH pattern.
- Page create/update via the existing `createPage`/`updatePageContent` with 2000-char chunking.
- Config keys are additive rows in the DB `config` table.

### Complex / Risky
- **Incremental-diff correctness:** the hash-compare + skip/update/archive branching is the core novelty. A bug here either re-pushes everything every cycle (hash never matches) or silently drops changes (hash always matches). The no-op-resync test (Verification #2) is the guard.
- **First-sync rate budget:** N×0.35s serialized; a large repo is 12+ minutes of Notion calls. Bounded by background execution + progress UI (plan 3/4), but the spacing is the floor.
- **Code-fence rendering across 2000-char blocks:** a 60KB file becomes ~30 adjacent Notion code blocks. Acceptable for v1 but a readability risk if the remote agent can't tell they're one file.
- **Archived-PATCH payload shape:** the existing client is built for block-children and property PATCHes; an `{ archived: true }` body-only PATCH to `/pages/{id}` should be confirmed against the client before relying on it.

## Dependencies

- `sess_phase2-codebase-doc-generator` — Codebase Doc Generator (produces the `CodebaseDocSet` this plan consumes).
- `sess_phase2-codebase-docs-sync-triggers-and-ui` — Continuous Sync Triggers + Remote-Tab Config (calls `syncCodebaseDocs` and surfaces its counts).
- `sess_phase2-remote-plan-from-notion-docs` — Remote Agent Orientation (soft-depends; the docs DB must be populated for the orientation to be true).

## Adversarial Synthesis

Key risks: (1) the incremental-diff logic is the single point of failure — a hash-mismatch bug re-pushes the whole codebase every cycle, burning the rate budget; mitigated by the no-op-resync assertion. (2) The 2000-char code-fence split renders one file as N adjacent blocks — a readability risk acknowledged as a v1 tradeoff with a lever (`perFileByteCap`). (3) The archived-PATCH payload shape is assumed but unconfirmed against the existing client. Mitigations are in place; the design is sound after the citation corrections and the rendering-decision documentation above.

## Edge-Case & Dependency Audit

- **Rate budget on first full sync:** a fresh repo pushes every page once — bounded by the serialized 350 ms queue (≈ N×0.35 s). Expected N range: a small repo ~50-200 pages (~20-70 s); a medium repo ~500-1000 pages (~3-6 min); a large repo ~2000+ pages (~12+ min). Run in the background with progress (plan 3/4). Subsequent syncs touch only changed files (typically a handful), so steady-state cost is tiny. The 350 ms spacing is the default floor; plan 3/4 may expose it as configurable if first-sync duration becomes a UX problem.
- **Hash collision across runs from non-determinism:** depends on plan 1/4's determinism guarantee (lexical ordering, no clock in content). If 1/4 regresses, every file would re-push every cycle — caught by the "skipped count ≈ total on a no-op re-sync" assertion in Verification.
- **Notion page edited by a human:** we full-clobber on next content change. Code docs are generated artifacts, not user-authored — overwriting is correct. (Contrast with plan pages, where overwrite is dangerous.) Documented in the remote skill (plan 4/4): don't hand-edit codebase doc pages.
- **Partial failure mid-sync:** each page is committed to the local table only *after* its Notion write succeeds, so a crash leaves a consistent partial state; the next run resumes (idempotent create/update by hash). No transaction spanning Notion + DB.
- **DB not configured / remote control off:** `ensureCodebaseDocsDatabase` early-returns if no `remote.notion.setup` parent page; `syncCodebaseDocs` is a clean no-op. No errors when Notion isn't wired.
- **Migration safety:** `codebase_docs_sync` is a new additive table — no existing-install risk (CLAUDE.md policy). No legacy keys touched.
- **No `/doc/notion` LocalApiServer route needed:** this sync is **extension-driven** (the extension calls `NotionFetchService` directly). The absence of an `/api/notion`/`/doc/notion` agent route is irrelevant here — agents don't push codebase docs; the extension does. (Agent-side *plan* write-back to Notion is a separate concern owned by the Remote Sync Refactor epic.)

## Proposed Changes

### `src/services/KanbanDatabase.ts`
- **Context:** `imported_docs` (280-303) is the inbound incremental-sync table; no outbound equivalent exists.
- **Logic:** Add `codebase_docs_sync` (additive `CREATE TABLE IF NOT EXISTS`, schema in "What Gets Built" §1) + CRUD helpers `getCodebaseDocSyncRows(workspaceId)`, `upsertCodebaseDocSync(row)`, `deleteCodebaseDocSync(slug, workspaceId)`, paralleling the imported-docs helpers (`registerImport` 2096-2118, `removeImport` 2120-2127, `getImportedDocs` 2129-2158).
- **Implementation:** Add to the migration/`CREATE TABLE` block alongside `imported_docs`. No destructive change (CLAUDE.md migration policy).
- **Edge Cases:** A row with a null `notion_page_id` (create failed mid-sync) is treated as "needs create" on the next run — idempotent.

### `src/services/NotionBackupService.ts`
- **Context:** `autoCreateDatabase` (165-231) + `_ensureColumnSelectOptions` (349-365) provision and extend managed DBs.
- **Logic:** Add `ensureCodebaseDocsDatabase(): Promise<string>` — return cached `remote.notion.codebaseDocsDatabaseId` if set, else `POST /databases` under the configured parent page with the six properties (Name/Path/Module/Doc Kind/Source Hash/Updated At), persist the id, return it. Idempotent.
- **Implementation:** Same file/pattern as `autoCreateDatabase`. Early-return if no `remote.notion.setup` parent page is configured.
- **Edge Cases:** Notion not configured → early-return (clean no-op, no error spew).

### `src/services/CodebaseDocsSyncService.ts` (new)
- **Context:** No outbound push pipeline exists; existing plan pushes are unconditional full re-pushes (`_upsertPlanToNotion` line 418).
- **Logic:** `syncCodebaseDocs(workspaceRoot, docSet)` — load sync rows, diff by `contentHash` (create/skip/update), archive deleted slugs, push overview→modules→files in order, serialize through a 350 ms-spaced queue, return counts. Builds on `NotionFetchService`'s existing `Retry-After` retry (76-117).
- **Implementation:** New file. The archived-PATCH (`{ archived: true }` on `/pages/{id}`) must be confirmed against the existing `httpRequest` client's payload handling before implementation.
- **Edge Cases:** Partial failure mid-sync commits each row only after its Notion write succeeds (consistent partial state; next run resumes). Hash collision from plan 1/4 non-determinism → caught by the no-op-resync test.

## Verification Plan

### Automated Tests

> Suite run separately by the user.

1. **Unit — first sync:** empty table + 3-doc set → 3 creates, 0 skips; rows persisted with page ids + hashes.
2. **Unit — no-op re-sync:** same doc set again → 0 creates, 0 updates, skipped == total, zero Notion write calls (assert via mocked client).
3. **Unit — changed file:** mutate one doc's hash → exactly 1 update, rest skipped.
4. **Unit — deleted file:** remove one doc from the set → 1 archive + row deleted.
5. **Unit — throttle:** assert calls are serialized with ≥ spacing; assert a 429 mock triggers the *existing* `Retry-After` path (no duplicate retry layer).
6. **Manual:** run a full sync against a real Notion test page; confirm the docs DB appears with overview/module/file pages; edit one source file, re-sync, confirm only that page updates.

## Out of Scope

- Generating the doc set (plan 1/4).
- Scheduling / commit-hook / timer / UI / config surface (plan 3/4).
- Teaching the remote agent to *use* these docs (plan 4/4).
- A Notion `Module` *relation* property (rich_text path is sufficient for v1 navigation).
- Linear/ClickUp doc targets (Notion-only per epic).
- Agent-facing `/doc/notion` write route (different epic).

## Recommendation

Complexity 6 → **Send to Coder.** New table + new service + new DB-provisioning method, all built on proven patterns. The risk concentrates in the incremental-diff correctness, which the no-op-resync test pins down.
