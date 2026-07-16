---
description: "Verb Engine subtask 6: PlanningPanelProvider burndown — migrate its 172 arms in place onto seams with returned results, collapse dispatch, delete shims. The largest provider: docs, tickets (ClickUp/Linear), research import, dev docs, NotebookLM, and the Project panel's six tabs."
---

# Verb Engine · 6 — PlanningPanelProvider Burndown (172 arms)

## Goal

Make every `PlanningPanelProvider` verb host-agnostic: all 172 arms run on injected seams, return their results in the HTTP body (push kept additive), and dispatch through the generic allowlist+schema registry; the provider's shims are deleted. With this subtask the burndown completes: 605/605 arms genuinely extracted, 0 shims, `_handleMessage` runnable headless across all five providers.

**Problem / context:** Planning is the largest provider (172 arms) and backs two webviews — the Artifacts panel (Docs, Tickets, Research, HTML, Dev Docs, NotebookLM tabs) and the Project panel (six tabs). Its arms span the ticket proxies (ClickUp/Linear via the token-injecting LocalApiServer paths), clipboard research/dev-doc imports, constitution/PRD/tuning file management, and doc sync. It goes last deliberately: by then the pattern is proven on four providers, and its bulk is spread across many small, independent arm clusters rather than one hot path. See `a2b-verb-engine-01-foundations.md` for the pattern and `a2b-genuine-verb-extraction-burndown.md` for the design record.

## Metadata
- **Tags:** backend, refactor, api
- **Complexity:** 7
- **Release phase:** After Verb Engine 1. Parallelizable with other provider subtasks (one agent stream per provider file). Completes the feature.

## User Review Required
- None — contract and pattern fixed in subtask 1.

## Scope

### ✅ IN SCOPE
- Migrate all 172 arms in place: `vscode.*` / `executeCommand` / raw `postMessage` → seam / domain-service / broadcaster calls; add `return` of each arm's result without reordering side effects.
- Ticket arms (fetch/edit/push/status/assign/tags/comments/attachments/move/subtasks) keep routing provider calls through the existing sync services — only host coupling moves behind seams; read verbs now return ticket data in-body (this unlocks readable ticket queries for external agents).
- Clipboard import arms (research → docs folder, dev docs) migrate with the clipboard read behind the seam; 200 KB cap, H1 title derivation, and registry writes unchanged.
- Governance arms (PRD save, constitution enable/paths, tuning extract/governance) migrate intact — file locations and injection behavior unchanged.
- Collapse the per-verb switch onto the generic registry; per-verb input schemas.
- Delete `planningService`'s string-keyed shims; keep genuinely shared domain logic only.
- **Feature close-out:** confirm the global ratchet reads 605/605 extracted, 0 shims, and the `ctx.handleMessage` back-door is demoted to the single generic dispatch entry or removed.

### ⚙️ OUT OF SCOPE
- Other providers (done by now). Webview/UI changes. New verbs or behavior changes. Standalone bootstrap (B1).

## Implementation Steps
1. Batch ~20–30 arms by tab cluster (docs / tickets / research+devdocs / project-panel tabs); migrate in place per the subtask-1 recipe; `compile-tests` gate between batches; merge incrementally.
2. Migrate the ticket cluster as coherent batches per provider (ClickUp, Linear) so sync-status semantics (`local`/`modified`/`synced`) stay reviewable.
3. Delete shims; run the feature close-out checks (605/605, 0 shims, back-door demoted/removed).

## Complexity Audit
### Routine
- Doc browse/edit/save arms; project-panel editor arms — swap + return.
### Complex / Risky
- **Sheer volume** (172 arms, two webviews' worth of surface) — discipline on batch size and the compile gate matters more here than anywhere.
- **Ticket sync-state semantics:** local-file/remote reconciliation and sync badges must not drift; auto-sync (save-on-load, push-on-save) behavior unchanged.
- **Multi-root resolution:** many arms resolve owning workspace roots for folders (docs/tickets) — `workspaceRoot` behavior must stay identical.

## Dependencies
- Verb Engine 1 (seams, dispatcher, return contract, test harness). Benefits from patterns settled in subtasks 2–5.

## Verification Plan
### Automated
- Provider tests pass unchanged. All 172 arms pass under the test-seam bundle. Global ratchet: 605/605, 0 shims.
### Manual / behavioral
- Round-trip a ticket (edit → push → comment), import a research doc from clipboard, save a PRD, run a tuning extract — identical via webview and `POST /planning/verb/<name>`, with read verbs returning data in-body.
