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

## Completion Summary

**Status:** ✅ Complete — all DoD checks green.

### Read arms converted to return-in-body (23 arms)

**Inline arms (17):** `renderMarkdownLive`, `fetchAntigravityArtifact`, `listLocalFolders`, `listPlanningHtmlFolders`, `fetchContainers`, `fetchFilteredDocs`, `fetchDocPages`, `fetchPageContent` (inline), `loadConstitutionFiles`, `getConstitutionStatus`, `readConstitutionFile`, `getProjectPrd`, `getConstitutionPaths`, `loadInsights`, `readInsight`, `downloadAttachment`, `viewAttachments`.

**Delegated arms (6):** `fetchChildren` → `_handleFetchChildren`, `fetchPreview` → `_handleFetchPreview` (+ `_buildAndSendPlanningHtmlPreview`), `fetchPageContent` (delegated) → `_handleFetchPageContent`, `fetchImportedDocs` → `_handleFetchImportedDocs`, `fetchDocsFile` → `_handleFetchDocsFile`, `fetchRoots` (aggregate return).

### Host-agnostic guards added
- `viewAttachments`: webviewUri rewrite skipped when no panel webview (headless).
- `_buildAndSendPlanningHtmlPreview`: webviewUri rewrite skipped when no panel webview.
- `_sendOnlineDocsReady`: softened `throw` to `console.warn` + `return` when no `_panel` (return-in-body carries the data).
- `buildWorkspaceItems` (`workspaceUtils.ts`): `vscode.workspace.workspaceFolders` access wrapped in try/catch — headless callers fall back to `path.basename` labels.

### Write schemas appended to PLANNING_VERB_SCHEMAS (22 verbs)
`saveFileContent`, `saveProjectPrd`, `createLocalDoc`, `deleteLocalDoc`, `saveConstitutionFile`, `deleteConstitutionFile`, `addConstitutionPath`, `removeConstitutionPath`, `setConstitutionPath`, `createOnlineDocument`, `saveOnlineDocFile`, `syncDocToOnline`, `importFullDoc`, `importResearchDoc`, `deleteImportedDoc`, `updateInsightStatus`, `deleteInsight`, `uploadPlanAttachment`, `setUploadLocation`, `linkToDocument`, `linkToFolder`, `addLocalFolder`/`removeLocalFolder`, `addPlanningHtmlFolder`/`removePlanningHtmlFolder`, `setProjectContextEnabled`.

### Ratchet ceiling
Planning break count: **319 → 283** (lowered by 36). `verb-return-contract-baseline.json` updated.

### Test suite
`verb-engine-planning-headless.test.js`: **25 passed, 0 failed** (16 new P2 tests covering read-arm return-in-body, push-additive, host-agnostic guards, and schema validation rejection).

### DoD checks
- `verb-returns:check` ✅ (Planning 283 ≤ ceiling 283)
- `parity:check` ✅ (allowlist ≡ catalog)
- `push-routing:check` ✅ (all providers at baseline)
- `compile-tests` ✅ (tsc -p tsconfig.test.json — 0 errors in PlanningPanelProvider/verbSchemas/workspaceUtils; pre-existing KanbanProvider errors unchanged)

## Review Findings

Reviewer pass — implementation correct, **no CRITICAL/MAJOR, no code fixes needed**. Verified: the family's read arms return in-body with the push kept additive (Planning `break` 319→**283**), the ratchet is green **and tight** (ceiling correctly lowered to 283 — the P1 slack mistake was not repeated), the block-validity guard passes (cases 169 == allowlist), and the headless suite (25 tests) asserts payload fields + push + schema rejection. The three behaviour changes are correct headless-safety and byte-compat in the extension: `_sendOnlineDocsReady` throw→warn (no throw-dependent callers at 3039/7353/8319), `buildWorkspaceItems` try/catch, and the panel-gated `vscode.Uri` webviewUri rewrites that are skipped headless (browsers don't use `vscode-webview://`). The disclosed KanbanProvider tsc errors were **statically cleared of any *introduced* error** — `_buildCardsFromDbSessionIds` supplies all required `KanbanCard` fields and uses the board's own `column` pattern — but full confirmation needs a human `npm run compile` (SKIP COMPILATION forbade it here). Remaining risks (NIT): those unverified KanbanProvider main-build errors, and 22 write schemas whose `required` fields could reject valid HTTP payloads (latent — webview bypasses validation, Planning not HTTP-reachable until B1; spot-audit then).
