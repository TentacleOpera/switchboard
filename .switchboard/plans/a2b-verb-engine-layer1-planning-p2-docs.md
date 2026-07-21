---
description: "Planning Layer-1, sub-card 2 of 3 (SEQUENTIAL, same file): the Docs / PRD / Constitution / Insights / Previews / Attachments verb family. Convert its read arms to return-in-body and add per-verb schemas; extend the headless Planning suite created by P1. Lands after P1 (a2b-verb-engine-layer1-completion-planning.md), before P3 (a2b-verb-engine-layer1-planning-p3-tickets.md)."
---

# Verb Engine — Layer-1: PlanningProvider · P2 — Docs / PRD / Constitution / Insights (Return-in-Body + Schemas + Test)

> **Split note:** sub-card 2/3 of the Planning burndown. **Hard order:** land after P1 (`a2b-verb-engine-layer1-completion-planning.md`), before P3 (`a2b-verb-engine-layer1-planning-p3-tickets.md`). Same file (`PlanningPanelProvider.ts`) → same single agent stream as P1/P3, never concurrent.

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, refactor, api
- **Complexity:** 5
- **Release phase:** B1 headless prerequisite (Layer 1, Planning provider — family 2/3). Gated by the return-contract ratchet.

## Goal

Convert the **Docs / PRD / Constitution / Insights / Previews / Attachments** verb family in `PlanningPanelProvider` to return-in-body, add per-verb schemas for its writes, and extend the headless Planning suite (created by P1) to cover it.

### Problem / root-cause analysis
Same root cause as P1 (see `a2b-verb-engine-layer1-completion-planning.md`): Planning arms push then `break`, and `planning: {}` schemas are empty. This card burns down the doc/constitution/insight family — the Project panel's "author PRDs, docs, constitution" surface — so those reads return data over `/project/verb/*` once the B1 wiring routes them here.

## User Review Required
- None.

## Scope
### ✅ IN SCOPE — the Docs/PRD/Constitution/Insights family only
- **Return-in-body conversion** for this family's read arms: `fetchDocsFile`, `fetchFilteredDocs`, `fetchImportedDocs`, `fetchDocPages`, `fetchPageContent`, `fetchContainers`, `fetchChildren`, `fetchRoots`, `getProjectPrd`, `getConstitutionPaths`, `getConstitutionStatus`, `loadConstitutionFiles`, `readConstitutionFile`, `loadInsights`, `readInsight`, `renderMarkdownLive`, `fetchPreview`, `listLocalFolders`, `listPlanningHtmlFolders`, `fetchAntigravityArtifact`, `viewAttachments`, `downloadAttachment` — keep the push, replace `break;` with `return { success: true, …<pushed fields> };`.
- **Per-verb schemas** under `planning: { … }` (append to P1's block) for this family's untrusted writes: `saveFileContent`, `saveProjectPrd`, `createLocalDoc`, `deleteLocalDoc`, `saveConstitutionFile`, `deleteConstitutionFile`, `addConstitutionPath`/`removeConstitutionPath`/`setConstitutionPath`, `createOnlineDocument`, `saveOnlineDocFile`, `syncDocToOnline`, `importFullDoc`, `importResearchDoc`, `deleteImportedDoc`, `updateInsightStatus`, `deleteInsight`, `uploadPlanAttachment`, `setUploadLocation`, `linkToDocument`, `linkToFolder`, `addLocalFolder`/`removeLocalFolder`, `addPlanningHtmlFolder`/`removePlanningHtmlFolder`, `setProjectContextEnabled`. Permissive/field-accurate.
- **Extend the headless Planning suite** with this family's arms; assert in-body data + push + no `vscode`.

### ⚙️ OUT OF SCOPE
- Plans & Features arms → **P1**. Tickets arms → **P3**.
- Standalone bootstrap wiring → B1 bootstrap plan.
- New verbs / behaviour changes.

## Implementation Steps
1. **Same single agent stream as P1** (started after P1 merges); `PlanningPanelProvider.ts` + append the doc/constitution schemas to the `planning` block.
2. Convert this family's read arms (Kanban idiom); add its write schemas.
3. Extend the headless Planning suite over this family.
4. **Lower the `planning` ratchet ceiling by this family's converted-arm count** (still partial until P3); note progress in `a2b-verb-engine-06-planning-panel.md`.

## Complexity Audit
### Routine
- Mechanical `break→return`; doc/constitution schemas are path + content strings.
### Complex / Risky
- **Live-markdown / doc-editor round-trips** — `renderMarkdownLive`, `saveFileContent`, PRD/constitution saves drive watchers and preview dedup; return the result without changing the write→watch→push ordering. Verify a doc save + preview refresh explicitly.
- **Attachment/upload arms** — return the stored ref shape the webview expects.

## Dependencies
- **Depends on P1** (creates the suite + the `planning` schema block this card appends to; same file).
- A2b ·1 Foundations; return-contract ratchet.
- **Blocks P3.**

## Verification Plan (Definition of Done — objective)
- `analyze-verb-migration2.js`: this family's read arms `return`; **`planning` ceiling lowered further**, `verb-returns:check` green at the new ceiling.
- `verbSchemas.ts` `planning` block extended to cover this family's writes.
- Headless Planning suite extended and **asserts payload fields** for this family.
- `parity:check` / `push-routing:check` / `compile-tests` green.
- Manual: `POST /project/verb/getProjectPrd` / `loadConstitutionFiles` return data in-body; a PRD/doc save round-trips; malformed payload rejected.
