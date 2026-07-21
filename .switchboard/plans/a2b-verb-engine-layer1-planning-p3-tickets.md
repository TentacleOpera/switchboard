---
description: "Planning Layer-1, sub-card 3 of 3 (SEQUENTIAL, same file): the Tickets (ClickUp/Linear) verb family — the largest family. Convert its read arms to return-in-body and add per-verb schemas; extend the headless Planning suite. Lands LAST, after P1 and P2. Completing this drives the planning ratchet ceiling to 0."
---

# Verb Engine — Layer-1: PlanningProvider · P3 — Tickets (ClickUp / Linear) (Return-in-Body + Schemas + Test)

> **Split note:** sub-card 3/3 of the Planning burndown — the final slice. **Hard order:** land after P1 (`a2b-verb-engine-layer1-completion-planning.md`) and P2 (`a2b-verb-engine-layer1-planning-p2-docs.md`), same single agent stream. When this completes, the `planning` ratchet ceiling reaches **0** — the objective signal that Planning Layer-1 is truly done.

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, refactor, api, security
- **Complexity:** 6
- **Release phase:** B1 headless prerequisite (Layer 1, Planning provider — family 3/3). Gated by the return-contract ratchet.

## Goal

Convert the **Tickets (ClickUp / Linear)** verb family in `PlanningPanelProvider` to return-in-body, add per-verb schemas for its untrusted writes (ticket create/edit/move/comment, provider config), and extend the headless Planning suite. This is the largest family and the last Planning slice; its completion flips the `planning` ratchet ceiling to 0.

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
4. **Lower the `planning` ratchet ceiling to 0** in the same change — Planning Layer-1 complete — and update `## Review Findings` in `a2b-verb-engine-06-planning-panel.md` and the Project feature file.

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
- `analyze-verb-migration2.js`: this family's read arms `return`; **`planning` ratchet ceiling == 0**, `verb-returns:check` green — Planning Layer-1 fully done.
- `verbSchemas.ts` `planning` block covers the tickets writes.
- Headless Planning suite covers this family and **asserts payload fields**.
- `parity:check` / `push-routing:check` / `compile-tests` green.
- Manual: `POST /project/verb/clickupLoadLists` / `linearLoadProjects` return data in-body; a ticket create + move + comment round-trips via `POST /project/verb/*` identically to the webview; a malformed ticket payload is rejected.
