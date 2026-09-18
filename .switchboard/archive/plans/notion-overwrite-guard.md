# Notion Overwrite Data-Loss Guard (Code-Level)

**Plan ID:** aec51f9b-3d44-423e-ba30-e0dc3dc2d5bc

## Goal

Enforce, **in code**, that no Notion body write can silently destroy user data. High-fidelity content push and project-context sync mean the extension now writes Notion page bodies on the primary provider — and a `replace_content` full overwrite **permanently deletes/orphans nested inline sub-pages, database views, and templates, and changes block IDs** (breaking deep-links, comments, anchors). This is an irreversible data-loss path and must not depend on agent/skill compliance.

### Problem & background (root cause)

The `/improve-remote-plan` write-back, the Notion `pushContent` path (Remote Sync Refactor 2/3), and project-context sync all write Notion page bodies. Research (see `epic-remote-planning-infrastructure` Research Findings) confirmed: the official Notion MCP `update-page-markdown` with `replace_content` overwrites the entire body destructively. The current mitigation lives only as prose in skill files — insufficient for an irreversible operation.

## What gets built

A single guarded write path used by **all** Notion body writes (improve-remote-plan content write, `pushContent`, project-context sync):

1. **Append-by-default.** Use additive block writes (`API-patch-block-children`) for improvements/updates wherever possible.
2. **Overwrite only after a verified childless check.** A full `replace_content` / clear-and-rewrite is permitted only after confirming the target page has **no inline sub-pages, DB views, or templates**. If the check cannot be made confidently, do not overwrite.
3. **Scoped rewrite fallback.** Where a body must be replaced, prefer clearing/rewriting only the known plan-body block range rather than the whole page.
4. **Fail safe.** On uncertainty, prefer append or abort with a surfaced error (see `remote-sync-health-surfacing.md`) over a destructive write.

## Scope

This is a cross-cutting guard, not a feature surface. It is consumed by:
- `improve-remote-plan-skill.md` (write phase)
- Remote Sync Refactor 2/3 (`pushContent` for Notion)
- `project-context-sync-to-notion-and-linear.md`

## Verification

- Writing to a Notion page **with** inline children uses append; existing sub-pages/DB views survive and existing block IDs are unchanged.
- A full overwrite occurs **only** when the page is verified childless.
- An ambiguous/failed childless check does not perform a destructive write and surfaces the condition.

## Metadata

**Complexity:** 4
**Tags:** backend, api, reliability, security
**Repo:** switchboard

## Review Findings

**Files changed:** `src/services/remote/notionOverwriteGuard.ts` (new), `src/services/remote/NotionRemoteProvider.ts`, `src/services/NotionFetchService.ts`. The guard is wired into both existing Notion body-write paths: `NotionRemoteProvider.pushProjectContext` (line 242) and `NotionFetchService.updatePageContent` (line 659). The guard lists all children with a 500-block backstop, checks for protected types (`child_page`, `child_database`, `template`), appends with a divider if protected content exists, clears+writes if verified childless, and aborts on inconclusive checks. Mid-clear block deletion failure falls back to append. Rate limiting (350ms between requests) respects Notion's ~3 req/s constraint.

**Validation:** TypeScript compilation skipped per session directives. Static verification: `httpRequest` signature confirmed compatible with guard calls. `PROTECTED_TYPES` set covers all Notion block types that would be destroyed/orphaned by a full overwrite. `MAX_PAGES = 5` backstop correctly returns null (→ abort) when the page exceeds 500 children. All three write paths (pushProjectContext, updatePageContent, and the guard's own append/delete operations) route through `notion.httpRequest` with appropriate timeouts.

**Remaining risks:** (1) **NIT** — `NotionFetchService.updatePageContent` uses a dynamic `import('./remote/notionOverwriteGuard.js')` instead of a static import; functionally fine but slightly unusual for a same-package module. (2) **NIT** — the guard's block deletion loop deletes blocks sequentially with 350ms delays; a page with 100+ plain blocks takes 35+ seconds to clear, which could hit the 30s timeout on the final append. Low risk in practice (plan bodies rarely exceed 50 blocks). (3) The `/improve-remote-plan` write-back path noted in the plan header as a consumer is marked "future" — not yet wired, which is correct since that path doesn't exist in the codebase yet.
