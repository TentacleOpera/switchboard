---
title: "Kanban pane in terminals.html shows feature subtasks as standalone cards (diverges from the board)"
created: 2026-08-06T12:48:45Z
complexity: 3
tags: [backend, bugfix, ui]
---

# Kanban pane in terminals.html shows feature subtasks as standalone cards

## Goal

Fix the kanban-mode pane in `terminals.html` so it stops rendering a feature's subtasks as standalone cards in the column list. The pane must match the kanban board's display contract: a feature's subtasks are rolled up under the feature card and are NOT shown as loose cards in their own `kanban_column`.

### Problem Analysis & Root Cause

The kanban board (`kanban.html`) and the terminals kanban pane both get their cards from the same canonical `_buildBoardCards` pipeline (`KanbanProvider.ts:1806`), which returns **every** card — including subtasks. A subtask card carries a non-empty `featureId` (`KanbanProvider.ts:1840`: `featureId: row.featureId || undefined`).

The **board** applies the roll-up contract client-side. `kanban.html:6267` and `kanban.html:6351` both do:

```javascript
displayCards = displayCards.filter(card => !card.featureId);
```

So subtasks never appear as standalone column cards on the board — they live nested under their feature.

The **terminals kanban pane** does not. Its data comes from the `getBoardCards` verb (`KanbanProvider.ts:10370-10408`). That handler builds the full card set via `_buildBoardCards`, then narrows by `column` and `project` only:

```typescript
let filtered = column ? cards.filter(c => c.column === column) : cards;
if (typeof msg.project === 'string' && msg.project !== '') {
    filtered = filtered.filter(c => (c.project || '') === msg.project);
}
```

It never drops subtasks (`!c.featureId`). The pane's `renderKanbanPane` (`terminals.js:2576-2694`) then iterates `cards` and renders every entry as a `.kanban-pane-row`, marking features with `is-feature` but still emitting a row for each subtask. Result: the pane shows a feature card **and** each of its subtasks as separate rows — exactly the divergence the user sees.

This is the same contract the backend already enforces for column-batch operations via `_visibleColumnCards` (`KanbanProvider.ts:468-471`: `... && !card.featureId`) and the batch-preview path (`KanbanProvider.ts:4298`: `if (c.featureId) return false;`). The `getBoardCards` verb is simply the one surface that forgot to apply it.

**Root cause:** `getBoardCards` omits the `!card.featureId` exclusion that every other board-display surface applies. The fix belongs in the verb handler, not the client — so the pane (and any future consumer of `getBoardCards`) inherits the contract for free and cannot drift again.

## Metadata

**Complexity:** 3
**Tags:** backend, bugfix, ui
**Project:** Browser Switchboard

## User Review Required

Yes — review the placement decision (backend verb handler vs. client-side pane filter) and confirm the wire-contract tightening is acceptable. The fix changes the `cards` array membership returned by `getBoardCards`: subtask cards (those with a non-empty `featureId`) are no longer included. The only current consumer is the terminals kanban pane, which is the intended beneficiary. A future consumer that wanted raw subtasks from this verb would need a distinctly-named verb (e.g. `getFeatureSubtasks`) — acceptable per the board display contract, but the user should sign off on the contract tightening.

## Complexity Audit

### Routine

- A single one-line filter addition inside an existing verb handler. The card shape already carries `featureId` (set by `_buildBoardCards` at `KanbanProvider.ts:1840`), so no schema or pipeline change is needed.
- The contract is already documented in three other places in the same file (`_visibleColumnCards` at `KanbanProvider.ts:468-471`, the batch-preview filter at `KanbanProvider.ts:4298`, and the comment block at `KanbanProvider.ts:453-462`), so this is closing a consistency gap, not introducing new behavior.
- No DB write, no migration, no schema change, no verb-surface change. The wire contract of `getBoardCards` (returns `{ success, cards, projects }`) is unchanged in shape; only the `cards` array's membership tightens to match the board.

### Complex / Risky

- **Wire-contract tightening (low risk).** The `getBoardCards` verb is consumed only by the terminals kanban pane (`terminals.js:2808`). Verified: the only `getBoardCards` references outside generated/catalog files are the pane fetch, the schema definition in `verbSchemas.ts`, and plan docs. No other caller relies on receiving subtasks. A future consumer wanting raw subtasks would need a separate verb — acceptable, but the contract change is real and should be acknowledged.
- **Selection-based verbs unaffected (low risk).** `promptSelected` (`KanbanProvider.ts:9291-9301`) and `selectPlan` from a pane row use the card's own `planId`/`sessionId` and are selection-based — they filter via `_cardMatchesIds` with explicit `msg.sessionIds`, deliberately NOT via `_visibleColumnCards`. Hiding subtasks from the list does not break linking/prompting a subtask that was previously visible; after the fix, subtasks simply won't appear as standalone rows, matching the board.
- **Visible behavior change — empty column (low risk).** A column that today contains *only* a feature's subtasks (no loose plans, no feature card in that column) currently shows those subtask rows. After the fix it shows the "No plans in …" empty state. This is *correct* — the board shows the same column empty (the subtasks are rolled up under a feature in a different column) — but it is a user-visible change worth an explicit parity check (see Verification Plan).
- **Adjacent pre-existing seam violation (out of scope).** The `getBoardCards` handler calls `vscode.workspace.getConfiguration('switchboard.activityLight')` directly at `KanbanProvider.ts:10392`, which is a pre-existing PRD contract #3 violation (host access must go through `hostSeams.ts`). This plan does NOT touch that line and does NOT fix it — it is noted here only so a coder does not mistake the surrounding handler for seam-clean. Tracking the seam fix is a separate concern.

## Edge-Case & Dependency Audit

- **Subtask whose column differs from its feature's column.** This is the exact case the board's roll-up exists to handle: a BACKLOG feature's subtask sitting in CREATED must NOT show as a loose CREATED card. Today the pane shows it; after the fix it won't — consistent with the board. No special-casing needed; `!card.featureId` covers all subtasks regardless of column.
- **Feature card itself.** Feature cards have `isFeature: true` and `featureId: undefined` (a feature is not its own subtask — `row.featureId` is empty for feature rows). The `!card.featureId` filter keeps feature cards. Verified at `KanbanProvider.ts:1839-1840`.
- **Completed column.** Completed subtasks pushed at `KanbanProvider.ts:1846-1860` also carry `featureId`. The filter removes them from the COMPLETED list too, matching the board (which applies the same `!card.featureId` after the column filter at `kanban.html:6351`). Features with `subtaskCount` still display their roll-up count.
- **Project filter interaction.** The `project` filter runs after the column filter today. Adding the subtask exclusion is order-independent with the project filter given the current card shape (a subtask carries `featureId` regardless of its own `project`), but it should be applied BEFORE the project filter so a subtask is never even considered. Placing it right after the column filter is cleanest and matches the board's order (column → featureId → project is not relevant on the board since it filters client-side, but excluding early is strictly safer). If a future change normalizes a subtask's `project` to its feature's project, this early-exclusion remains correct because it drops subtasks before the project filter ever runs.
- **No `getBoardCards` unit test exists today** (verified: no `.test.ts` file references `getBoardCards`). Verification is via the live verb smoke test and the pane/board parity check (see Verification Plan). A regression test asserting `getBoardCards` returns no card with a non-empty `featureId` would lock this contract machine-checkably — named here as tracked debt (see Verification Plan → Automated Tests), not written this session per the skip-tests directive.

## Dependencies

- None. This is a self-contained one-line filter addition to an existing verb handler. No prior plan must land first; no downstream plan depends on it.

## Adversarial Synthesis

Key risks: (1) the fix tightens the `getBoardCards` wire contract — subtask cards are permanently excluded, so a future consumer wanting raw subtasks would need a separate verb; (2) a column that today shows *only* subtasks will flip to the "No plans in …" empty state — correct vs. the board but a user-visible change; (3) the contract fix ships with no automated regression guardrail (manual smoke test only). Mitigations: backend placement is the correct layer (matches `_visibleColumnCards` and batch-preview server-side precedent, so all `getBoardCards` consumers inherit the contract and cannot drift); the empty-column flip is verified by an explicit board/pane parity check; the missing regression test is named as tracked debt so it is not lost. The adjacent pre-existing `vscode.workspace.getConfiguration` seam violation at line 10392 is out of scope and noted only to prevent a coder from assuming the handler is seam-clean.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `getBoardCards` handler (line ~10396)

Add the subtask exclusion immediately after the column filter, mirroring the board's `displayCards.filter(card => !card.featureId)` and the backend's own `_visibleColumnCards` contract.

**Before** (`KanbanProvider.ts:10395-10403`):
```typescript
// Optional column filter (narrow to one column for the kanban-mode pane).
const column = typeof msg.column === 'string' ? msg.column : null;
let filtered = column ? cards.filter(c => c.column === column) : cards;
// Optional project filter (narrow to one project for the kanban-mode pane).
// An empty-string project matches plans with no project assigned (the
// board's UNASSIGNED_PROJECT_FILTER convention).
if (typeof msg.project === 'string' && msg.project !== '') {
    filtered = filtered.filter(c => (c.project || '') === msg.project);
}
```

**After**:
```typescript
// Optional column filter (narrow to one column for the kanban-mode pane).
const column = typeof msg.column === 'string' ? msg.column : null;
let filtered = column ? cards.filter(c => c.column === column) : cards;
// Roll feature subtasks up under their feature card — they are NOT standalone
// column cards. This verb returns the board DISPLAY set (not the raw full card
// set), so it mirrors the board's display contract (kanban.html:
// displayCards.filter(card => !card.featureId)) and the backend's own
// _visibleColumnCards (line 468). Without this, the terminals kanban pane
// renders a feature's subtasks as loose rows alongside the feature card.
// Order-independent with the project filter below given the current card shape
// (a subtask carries featureId regardless of its own project); placed before
// the project filter so a subtask is never even considered.
filtered = filtered.filter(c => !c.featureId);
// Optional project filter (narrow to one project for the kanban-mode pane).
// An empty-string project matches plans with no project assigned (the
// board's UNASSIGNED_PROJECT_FILTER convention).
if (typeof msg.project === 'string' && msg.project !== '') {
    filtered = filtered.filter(c => (c.project || '') === msg.project);
}
```

No other file changes. The pane's `renderKanbanPane` needs no change — it already renders whatever cards it receives, and the `is-feature` styling for feature cards remains correct (feature cards still arrive; subtask cards no longer do).

## Verification Plan

### Automated Tests

No automated tests are run or written this session (per the skip-tests directive). No `getBoardCards` unit test exists today (verified: no `.test.ts` file references `getBoardCards`). Verification is via the live verb smoke test and the pane/board parity checks below.

**Tracked debt (not written this session):** a regression test asserting `getBoardCards` returns no card with a non-empty `featureId` (and that feature cards with `subtaskCount > 0` still appear) would lock this display contract machine-checkably and match the PRD's "done is machine-checked, not asserted" gate. Recommended follow-up: add `src/services/__tests__/KanbanProvider.getBoardCards.test.ts` stubbing the DB via the existing test seam pattern, asserting the `featureId` exclusion across CREATED and COMPLETED columns. This is debt, not a blocker for this change.

### Manual Verification

1. **Live verb smoke test — subtask exclusion:** with the extension running, create or locate a feature that has at least one subtask whose `kanban_column` matches a non-feature column (e.g. a feature in BACKLOG with a subtask in CREATED). Then:
   ```bash
   PORT=$(cat .switchboard/api-server-port.txt)
   curl -s -X POST http://127.0.0.1:$PORT/kanban/verb/getBoardCards \
     -H 'Content-Type: application/json' \
     -d '{"column":"CREATED"}' | jq '[.cards[] | {topic, isFeature, featureId}]'
   ```
   Confirm: no card in the response has a non-empty `featureId`. Feature cards (`isFeature: true, featureId: null`) remain.
2. **Board/pane parity:** open the kanban board tab and a terminals kanban pane on the same column. Confirm the row count and row set match exactly — no extra subtask rows on the pane side.
3. **Empty-column parity (the visible behavior change):** locate or construct a column that contains *only* a feature's subtasks (no loose plans, no feature card in that column — e.g. a BACKLOG feature with a subtask in CREATED and no other CREATED plans). Confirm the pane shows the "No plans in …" empty state for that column, and that the board's same column is also empty (subtasks rolled up under the feature elsewhere). Both surfaces must agree.
4. **Feature card still present:** confirm a feature card with `subtaskCount > 0` still appears in the pane list (the filter removes subtasks, not features).
5. **Completed column parity:** repeat step 1 with `"column":"COMPLETED"` — completed subtasks are excluded, completed features remain.
6. **Project filter still works:** repeat with `"column":"CREATED","project":"<someProject>"` — filtering still narrows correctly and no subtasks leak through.

## Recommendation

Complexity 3 → **Send to Intern.** A single one-line filter addition with a documented contract, no schema/DB/migration impact, and a clear before/after. The only judgment call (backend vs. client-side placement) is settled in the plan and confirmed by the user-review gate above.

## Completion Report

Implemented the `!c.featureId` subtask exclusion in the `getBoardCards` verb handler at `src/services/KanbanProvider.ts:10398-10407`, immediately after the column filter and before the project filter. This aligns the terminals kanban pane with the board's roll-up contract and the existing `_visibleColumnCards` / batch-preview precedents. Only `src/services/KanbanProvider.ts` was modified; no client-side pane changes were required. Compilation and tests were skipped per the task directives.

## Review Findings

**Reviewer pass (in-place, independent).** The change is a single one-line filter (`filtered = filtered.filter(c => !c.featureId);` at `KanbanProvider.ts:10407`) with a 9-line contract comment, placed exactly as the plan specifies — after the column filter, before the project filter. No CRITICAL or MAJOR findings; no code fixes required.

**Regression analysis:** (1) Sole consumer is `terminals.js:2808` (pane fetch) — no other caller in `LocalApiServer.ts`, `bootstrap.ts`, or test files; schema in `verbSchemas.ts:179` is permissive and unchanged. (2) No double-trigger — no UI refresh added; pane re-renders on existing poll. (3) No race condition — pure synchronous filter on an already-built array; no DB writes, watchers, or mtime checks. (4) No orphaned references — no dead code removed or identifiers renamed. (5) Full path traced: `_buildBoardCards` → column filter → featureId filter (NEW) → project filter → return; `renderKanbanPane` iterates result unchanged. `featureId` set at lines 1840/1858 (`row.featureId || undefined`); features have `undefined`, subtasks have non-empty — filter correctly keeps features, drops subtasks across CREATED and COMPLETED columns.

**Verification results:** `npm run compile` (webpack) — 0 errors, 4 pre-existing optional-dep warnings. `tsc -p tsconfig.test.json` (compile-tests) — passed. `npm run lint` — 0 errors, 2490 pre-existing warnings. `npm run verb-returns:check` — Kanban 0 <= ceiling 0 ✅. `npm run parity:check` — passed ✅. `npm run push-routing:check` — KanbanProvider 1 <= baseline 1 ✅. `npm test --grep KanbanProvider` — vscode-test harness SIGKILL'd during VS Code launch (environment issue: binary named `Code` not `Electron`); the KanbanProvider test file does not test `getBoardCards` (confirmed by grep), so this does not affect confidence in the change.

**Gate-wiring audit:** All three PRD-mandated gates are defined in `package.json` (lines 845/847/848) and invoked in `.github/workflows/integration-tests.yml` ("Protocol parity check", "Push-routing ratchet (Gap A)", "Verb return-contract ratchet" steps). No gate is defined-but-not-invoked. The plan names no new automated check requiring wiring — the regression test is explicitly tracked debt.

**Remaining risks:** (1) The tracked-debt regression test (`KanbanProvider.getBoardCards.test.ts`) is not written — the contract is enforced by precedent and manual verification, not machine-checked. (2) The adjacent pre-existing seam violation at line 10392 (`vscode.workspace.getConfiguration`) remains out of scope. (3) The vscode-test harness could not execute in this environment; a subsequent CI run will confirm the full test suite.
