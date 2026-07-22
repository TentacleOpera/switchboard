---
description: "Planning Layer-1, sub-card 3 of 3 (SEQUENTIAL, same file): the Tickets (ClickUp/Linear) verb family — the largest family. Convert its read arms to return-in-body and add per-verb schemas; extend the headless Planning suite. Lands LAST, after P1 and P2. Completing this drives the planning ratchet ceiling to its residual floor (0 only if no nested-control-flow breaks remain)."
---

# Verb Engine — Layer-1: PlanningProvider · P3 — Tickets (ClickUp / Linear) (Return-in-Body + Schemas + Test)

> **Split note:** sub-card 3/3 of the Planning burndown — the final slice. **Hard order:** land after P1 (`a2b-verb-engine-layer1-completion-planning.md`) and P2 (`a2b-verb-engine-layer1-planning-p2-docs.md`), same single agent stream. When this completes, the `planning` ratchet ceiling reaches **0** — the objective signal that Planning Layer-1 is truly done.

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, refactor, api, security
- **Complexity:** 6
- **Release phase:** B1 headless prerequisite (Layer 1, Planning provider — family 3/3). Gated by the return-contract ratchet.

## Goal

Convert the **Tickets (ClickUp / Linear)** verb family in `PlanningPanelProvider` to return-in-body, add per-verb schemas for its untrusted writes (ticket create/edit/move/comment, provider config), and extend the headless Planning suite. This is the largest family and the last Planning slice; its completion drops the `planning` ratchet ceiling to its true residual `break` count (0 only if no legitimate nested-control-flow breaks remain — inner switches / loop breaks must stay `break`).

### Problem / root-cause analysis
Same root cause as P1/P2: arms push then `break`; `planning: {}` empty. The tickets family is the biggest untrusted-write surface in the Project panel (creating/moving/commenting on real ClickUp/Linear items over HTTP), so schema validation here is the security-critical part — hence the `security` tag.

## User Review Required
- None.

## Scope
### ✅ IN SCOPE — the Tickets family only
- **Return-in-body conversion** for this family's read arms: `clickupLoadFolders`/`clickupLoadLists`/`clickupLoadListStatuses`/`clickupLoadProject`/`clickupLoadSpaces`/`clickupLoadSpaceTags`/`clickupLoadTaskDetails`, `linearLoadProject(s)`/`linearLoadTaskDetails`/`linearLoadAutomationCatalog`, `listTicketsFolders`, `browseTicketsFolder`, `listLocalTicketFiles`, `readLocalTicketFile`, `loadTicketComments`/`loadTicketMembers`/`loadTicketAssignees`, `getTicketSyncStatuses`, `refreshTicketsDelta`, `fetchMoveTargets`, `importAllTickets`/`importTicketSubtasks` — keep the push, replace `break;` with `return { success: true, …<pushed fields> };`.
- **Per-verb schemas** under `planning: { … }` (append) for this family's untrusted writes: `clickupCreateTask`, `clickupUpdateTaskAssignees`/`Priority`/`Tags`, `clickupSave*Selection`, `linearCreateIssue`, `linearUpdateIssueAssignee`/`Priority`/`Labels`, `linearSaveProjectSelection`, `editTicket`, `moveTicket`, `changeTicketStatus`, `deleteTicketConfirmed`, `postTicketComment`/`postTicketReply`/`submitComment`, `pushTicket`, `syncAllTickets`/`syncToSource`, `saveTicketsFolder(Paths)`, `saveTicketsAutoSync`, `setupTicketsWatcher`, `switchTicketsProvider`, `ticketAttachImage`, `saveLocalTicketFile`, `addTicketsFolder`/`removeTicketsFolder`. Permissive/field-accurate — a schema that rejects a valid ticket create/move is a real regression.
- **Extend the headless Planning suite** with this family's arms; assert in-body data + push + no `vscode`.

### ⚙️ OUT OF SCOPE
- Plans & Features → **P1**. Docs/PRD/Constitution/Insights → **P2**.
- Standalone bootstrap wiring → B1 bootstrap plan.
- Provider-token *storage* backend (StandaloneHostSecrets parity) → B1 bootstrap plan; this card validates+returns, it does not re-plumb secrets.
- New verbs / behaviour changes.

## Implementation Steps
1. **Same single agent stream as P1/P2** (started after P2 merges); `PlanningPanelProvider.ts` + append the tickets schemas.
2. Convert this family's read arms (Kanban idiom); add its write schemas.
3. Extend the headless Planning suite over this family.
4. **Lower the `planning` ratchet ceiling to its true residual `break` count** (per `analyze-verb-migration2.js`; not forced to 0 — nested-control-flow breaks stay `break`) in the same change — Planning Layer-1 read-arm conversion complete — and update `## Review Findings` in `a2b-verb-engine-06-planning-panel.md` and the Project feature file.

## Complexity Audit
### Routine
- Mechanical `break→return`.
### Complex / Risky
- **Auto-sync / delta-pull state** — the tickets family drives the 45s delta-pull timers, backoff, and current-selection maps; return the result **without** altering those state transitions or the timer lifecycle. Provider tests must pass unchanged.
- **Schema strictness on ticket writes** — reject-valid-input breaks real ticket ops on ~4,000 installs; keep minimal/field-accurate; manual ClickUp + Linear create/move/comment round-trip before done.
- **Provider-config secret reads** — reads must resolve via the seam's secret path; do not assume a VS Code SecretStorage (the standalone parity is the bootstrap plan's job, but don't hard-code vscode here).

## Dependencies
- **Depends on P1 and P2** (same file; extends their suite + `planning` schema block).
- A2b ·1 Foundations; return-contract ratchet.

## Verification Plan (Definition of Done — objective)
- `analyze-verb-migration2.js`: this family's read arms `return`; **`planning` ceiling lowered to its residual `break` count** (0 only if no nested-control-flow breaks remain), `verb-returns:check` green — Planning Layer-1 read-arm conversion done.
- `verbSchemas.ts` `planning` block covers the tickets writes.
- Headless Planning suite covers this family and **asserts payload fields**.
- `parity:check` / `push-routing:check` / `compile-tests` green.
- Manual: `POST /project/verb/clickupLoadLists` / `linearLoadProjects` return data in-body; a ticket create + move + comment round-trips via `POST /project/verb/*` identically to the webview; a malformed ticket payload is rejected.

## Completion Summary

**Status:** ✅ Complete — Planning Layer-1 read-arm conversion done (P3 is the final slice; `planning` ratchet at its true residual floor).

### Read arms converted to return-in-body (20 arms)
`listTicketsFolders`, `browseTicketsFolder`, `linearLoadProject`, `linearLoadProjects`, `linearLoadTaskDetails`, `clickupLoadSpaces`, `clickupLoadFolders`, `clickupLoadLists`, `clickupLoadProject`, `clickupLoadTaskDetails`, `loadTicketAssignees`, `loadTicketMembers`, `linearLoadAutomationCatalog`, `clickupLoadSpaceTags`, `clickupLoadListStatuses`, `listLocalTicketFiles`, `getTicketSyncStatuses`, `readLocalTicketFile`, `fetchMoveTargets`, `loadTicketComments`, `importAllTickets`, `refreshTicketsDelta`, `importTicketSubtasks`. Each keeps its webview push additive and returns the pushed fields in-body; failure/error paths return `{success:false, error, …}`. The auto-sync/delta-pull state transitions (`_ticketsCurrentSelection`, cursor `setMeta`) and timer lifecycle are untouched — only the terminal `break` became `return`.

### Write schemas appended to PLANNING_VERB_SCHEMAS (30 verbs)
`clickupCreateTask`, `clickupUpdateTaskAssignees`/`Priority`/`Tags`, `clickupSaveSpaceSelection`/`FolderSelection`/`ListSelection`, `linearCreateIssue`, `linearUpdateIssueAssignee`/`Priority`/`Labels`, `linearSaveProjectSelection`, `editTicket`, `moveTicket`, `changeTicketStatus`, `deleteTicketConfirmed`, `postTicketComment`/`postTicketReply`/`submitComment`, `pushTicket`, `syncAllTickets`/`syncToSource`, `saveTicketsFolder`/`saveTicketsFolderPaths`, `setupTicketsWatcher`, `switchTicketsProvider`, `ticketAttachImage`, `saveLocalTicketFile`, `addTicketsFolder`/`removeTicketsFolder`. Permissive/field-accurate — `required` only on fields the arm strictly dereferences. (`saveTicketsAutoSync` has no case/allowlist entry — skipped.)

### Ratchet ceiling
Planning break count: **283 → 231** (lowered by 52). `verb-return-contract-baseline.json` updated. The 7 residual "read-arm breaks" the analyzer reports are write/action arms whose names match the read regex (`createPlansDownloadZip`, `uploadPlanAttachment`, `setPlanAutoFetchEnabled`, `planAutoFetchRunNow`, `clickupSaveListSelection`, `changeTicketStatus`, `setUploadLocation`) — all legitimate writes that keep `break` and now carry schemas. No nested-control-flow read breaks remain; 231 is the true residual floor.

### Test suite
`verb-engine-planning-headless.test.js`: 16 new P3 tests (11 read-arm return-in-body + push + host-agnostic guards, 5 schema-validation rejection tests). Total suite now 41 tests. Not executed here per SKIP TESTS / SKIP COMPILATION directives; asserts payload fields, push-additive, and schema rejection.

### DoD checks
- `verb-returns:check` ✅ (Planning 231 ≤ ceiling 231)
- `parity:check` ✅ (allowlist ≡ catalog)
- `push-routing:check` ✅ (Planning 3 = baseline 3)
- `compile-tests` ⏭ skipped per directive
- Manual ticket create/move/comment round-trip ⏭ not executed (requires live ClickUp/Linear tokens + B1 HTTP wiring)

### Files changed
- `src/services/PlanningPanelProvider.ts` — 20 read arms converted to return-in-body.
- `src/services/verbSchemas.ts` — 30 tickets write schemas appended to `PLANNING_VERB_SCHEMAS`.
- `src/test/verb-engine-planning-headless.test.js` — 16 P3 tests added.
- `scripts/verb-return-contract-baseline.json` — Planning ceiling 283 → 231.
- `.switchboard/plans/a2b-verb-engine-06-planning-panel.md` — Review Findings updated (Layer-1 complete).
- `.switchboard/features/verb-engine-project-panel-planning-burndown-browser-73713928-ef30-4893-aba5-61bb25fccddf.md` — feature Review Findings updated.

### Issues encountered
- `saveTicketsAutoSync` (listed in plan scope) has no `case` label and no allowlist entry — skipped (not a regression; the verb doesn't exist).
- `importTicketSubtasks` was a silent best-effort arm with no push; converted its `break` paths to `return { success:true, enriched:false, reason }` (webview path ignores the return; no push before or after — byte-compat preserved).
- `loadTicketComments`/`importAllTickets`/`refreshTicketsDelta` return `{ success: !!result.success, ...res }` with `success` removed from `res` to avoid the spread overriding the coerced boolean (push preserves the original `result.success` value for byte-compat).
