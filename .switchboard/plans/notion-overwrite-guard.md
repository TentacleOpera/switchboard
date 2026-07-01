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
