# Fix Researcher Column Position and Forward Flow: Research Feeds Coding, Not Planning

## Goal

Move the `RESEARCHER` column to sit **after** `PLAN REVIEWED` (Planned) and **before** `LEAD CODED`, and make a card advancing out of Researcher go to **Lead Coder** instead of back to Planned.

### The problem

Research is triggered *by the planner*, during or after planning — the `advise_research` skill is appended to the planner's prompt (`src/services/agentPromptBuilder.ts:1209`), and the planner hands a research prompt to the Researcher agent via `/research/dispatch` (`agentPromptBuilder.ts:747`). Once that research comes back, the plan is ready to be **coded**. Sending the card back to Planned is a loop — the planning work is already done.

Two defects produce that loop:

1. **Wrong column position.** `src/services/agentConfig.ts:134` declares `RESEARCHER` at `order: 90`, ahead of `PLAN REVIEWED` at `order: 100`. `buildKanbanColumns` sorts by `order` (`agentConfig.ts:446`), so Researcher renders to the *left* of Planned — implying research precedes planning, which is backwards.

2. **Wrong forward target, hardcoded in one host.** `src/standalone/bootstrap.ts:131` hardcodes `'RESEARCHER': 'PLAN REVIEWED'` in `getNextKanbanColumn`. This is order-independent, so it stays wrong no matter where the column sits.

The extension host derives the target from position instead — `KanbanProvider._getNextColumnId()` (line 5687) does `allColumns.findIndex()` then walks forward past `shouldSkip` entries. At order 90 the sorted list is `[CREATED, RESEARCHER, PLAN REVIEWED, …]`, so it currently lands on `PLAN REVIEWED` — the same wrong answer, reached by a different mechanism.

So the two hosts agree today only by coincidence: one hardcodes the wrong target, the other derives it from a wrong position.

### Why fixing the position fixes most of it

Because `_getNextColumnId` is order-derived, re-weighting the column **automatically** corrects the extension host. With `RESEARCHER` between 100 and 180, the sorted list becomes `[CREATED(0), PLAN REVIEWED(100), RESEARCHER(110), LEAD CODED(180), …]`; `findIndex` returns index 2 and the forward walk lands on `LEAD CODED`. `shouldSkip` does not reject it — `LEAD CODED` is not `featureOnly`, not `ACCEPTANCE TESTED`, its `dragDropMode` is `'cli'` (not `'disabled'`), and its `role` (`lead`) is skipped only if the operator has hidden the Lead agent, which is the correct existing behaviour.

Only the standalone hardcoded map needs an explicit edit.

## Metadata

**Tags:** backend, ui, bugfix
**Complexity:** 4
**Project:** Browser Switchboard

> **Superseded:** Complexity 3 (original).
> **Reason:** Each edit is a one-liner, but the change spans three files across two hosts (`agentConfig.ts`, `bootstrap.ts`, `KanbanProvider.test.ts`) and alters kanban forward-flow behaviour — not the "single-file, localized" descriptor for Routine 1-4. The cross-host coordination and test-rewriting undersell a score of 3.
> **Replaced with:** Complexity 4 — multi-file, low-risk, reuses existing patterns, but a cross-host behaviour change with test updates. Send to Coder.

## User Review Required

Yes — confirm the intended board layout (Researcher between Planned and Lead Coder) is the desired default. ~4,000 installs with no column override will see the Researcher column visibly move right of Planned on next update. Installs that drag-reordered columns keep their chosen position (override wins), so only default-layout installs are affected visually.

## Complexity Audit

### Routine
- One numeric edit: `RESEARCHER` `order` `90` → `110` in `src/services/agentConfig.ts:134`.
- One string edit: `'RESEARCHER': 'PLAN REVIEWED'` → `'RESEARCHER': 'LEAD CODED'` in `src/standalone/bootstrap.ts:131`.
- Updating three test cases in `src/services/__tests__/KanbanProvider.test.ts` to encode the new target/position.

### Complex / Risky
- Verifying the extension host's `_getNextColumnId` forward walk lands on `LEAD CODED` after the re-weight **without** adding a hardcoded `RESEARCHER` arm — the plan's thesis is that position now carries the meaning. If the walk does not land there, find out why before any special case.
- Cross-host agreement: the standalone `getNextKanbanColumn` is a static map (not position-derived), so it ignores `kanbanOrderOverrides`. For installs that drag-reordered columns, the extension host follows their ordering while standalone forces `LEAD CODED` — a pre-existing divergence this plan does not introduce but does not fix either.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The change is to static config and a static map; no concurrent state.
- **Security:** No input handling, no new verbs. No surface.
- **Side Effects:** Re-weighting `RESEARCHER` shifts the column's default position for every install with no override — intended. `buildKanbanColumns` sorts by `order` (`agentConfig.ts:446`), so the board re-renders with Researcher between Planned and Lead Coder. The standalone forward-map change affects `moveAll` (`bootstrap.ts:824`) and dispatch (`bootstrap.ts:1241`) advancement out of Researcher.
- **Dependencies & Conflicts:** The companion plan "Order Terminal Sidebar Rows…" (`e3e14fa8-ce4a-45b1-9bad-67eb770bec6e`) depends on THIS plan landing `RESEARCHER` at `110` so its sidebar fallback constant mirrors correctly — land this plan first. No migration needed: `kanbanOrderOverrides` is only written on explicit drag-reorder (`TaskViewerProvider.handleUpdateKanbanStructure`, lines 10162-10166), so installs that never reordered pick up `110` automatically; installs that reordered keep their chosen position (override wins, `agentConfig.ts:427-431`). Do **not** stamp `110` over existing overrides — that discards a deliberate operator choice.

## Dependencies

- Required by `feature_plan_20260806074849_terminal-sidebar-role-ordering` (`e3e14fa8-ce4a-45b1-9bad-67eb770bec6e`) — the terminal sidebar plan's fallback constant mirrors `DEFAULT_KANBAN_COLUMNS`, so this re-weight must land first for the sidebar to place researcher after planner at first paint.

## Adversarial Synthesis

Key risks: (1) the extension host derivation could fail to land on `LEAD CODED` if an unseen `shouldSkip` condition rejects it — mitigated by reading `_getNextColumnId` (confirmed: `LEAD CODED` is not `featureOnly`, `dragDropMode` is `'cli'`, role `lead` skipped only if the operator hid Lead) and by Verification steps 3 and 5; (2) the standalone static map ignores operator overrides, so reordered installs diverge between hosts — pre-existing, not a regression, flagged for awareness; (3) the test at `KanbanProvider.test.ts:164` ("CREATED → skips hidden RESEARCHER") loses its premise after the re-weight and must be repointed or deleted, not left asserting a now-accidental pass. Mitigations in place; the plan is sound.

## Proposed Changes

**Context:** Two defects cause the Researcher→Planned loop: `RESEARCHER` sits at `order: 90` (ahead of `PLAN REVIEWED` at 100), and the standalone `getNextKanbanColumn` hardcodes `'RESEARCHER': 'PLAN REVIEWED'`. Re-weighting the column to 110 auto-corrects the extension host's position-derived `_getNextColumnId`; only the standalone hardcoded map needs an explicit edit. No migration — overrides win and are preserved.

### 1. Re-weight the column

`src/services/agentConfig.ts:134` — change `RESEARCHER`'s `order` from `90` to `110`.

`110` sits cleanly between `PLAN REVIEWED` (100) and `LEAD CODED` (180) without colliding with any existing weight, and leaves room on both sides. Leave every other field (`role: 'researcher'`, `kind: 'review'`, `autobanEnabled: false`, `dragDropMode: 'prompt'`) unchanged.

### 2. Fix the standalone forward map

`src/standalone/bootstrap.ts:131` — change `'RESEARCHER': 'PLAN REVIEWED'` to `'RESEARCHER': 'LEAD CODED'`.

### 3. Confirm the extension host follows without a special case

No edit expected in `KanbanProvider._getNextColumnId()`. Verify by test rather than by reading — if the forward walk does *not* land on `LEAD CODED` after the re-weight, find out why before adding any special case. Adding a hardcoded `RESEARCHER` arm should be a last resort, since the whole point of the re-weight is that position now carries the meaning.

### 4. Update the tests that encode the old behaviour

- `src/services/__tests__/KanbanProvider.test.ts:206` — `'Recovery: RESEARCHER -> next advances to PLAN REVIEWED even when researcher invisible'` asserts the old target. Update the expectation to `LEAD CODED` and rename the test.
- `src/services/__tests__/KanbanProvider.test.ts:145` — the fixture copy of the `RESEARCHER` column definition carries `order: 90`. Update to `110` so the fixture matches production.
- `src/services/__tests__/KanbanProvider.test.ts:164` — `'CREATED -> next skips hidden RESEARCHER when researcher not visible'`. With Researcher no longer between CREATED and PLAN REVIEWED, this test's premise is gone: `CREATED`'s next is `PLAN REVIEWED` via the hardcoded switch regardless. Either delete it or repoint it at the new adjacency (`PLAN REVIEWED` → next skips hidden `RESEARCHER` → `LEAD CODED`), which is the case actually worth covering now.

### 5. Existing installs

`kanbanOrderOverrides` is only written when the operator has explicitly drag-reordered columns in Setup (`TaskViewerProvider.handleUpdateKanbanStructure`, line 10162-10166). So:

- **Installs that never reordered** have no override for `RESEARCHER` and will pick up `110` — the column visibly moves right of Planned. That is the intent of this plan, not a regression.
- **Installs that did reorder** already have an override for every visible reorderable column, which wins over the default in `buildKanbanColumns` (line 427-431). Their board is unchanged, and their Researcher column keeps whatever position they chose. Their *forward flow* still improves via step 2 on standalone; on the extension host it continues to follow their own ordering, which is correct — they expressed a position deliberately.

No migration is required: no data is destroyed, no key is dropped, and both branches land in a coherent state. Do **not** write a migration that stamps `110` over existing overrides — that would discard a deliberate operator choice.

## Verification Plan

Build and install the VSIX before manual checks — `dist/` is not served during development and the browser panel's live server reads the installed bundle, so `src/` edits are otherwise invisible.

Baseline `npm test` first and record the already-red set, so new breakage is attributable.

1. `npm test` — `src/services/__tests__/KanbanProvider.test.ts` green with the updated expectations; `src/services/__tests__/agentPromptBuilder.test.ts:270` (`columnToPromptRole('RESEARCHER') === 'researcher'`) untouched and still green.
2. **Board position.** Open the Kanban board on a workspace with no column overrides. Confirm Researcher now renders between Planned and Lead Coder.
3. **Forward flow, extension host.** Put a card in Researcher, advance it. Confirm it lands in **Lead Coder**, not Planned.
4. **Forward flow, standalone host.** Repeat step 3 in the standalone browser board — this exercises the `bootstrap.ts` map rather than `_getNextColumnId`. Both hosts must now agree.
5. **Hidden Lead agent.** Hide the Lead agent, then advance a card out of Researcher. Confirm `shouldSkip` moves it past Lead Coder to the next eligible column rather than stalling or returning null.
6. **Operator override preserved.** On a workspace where columns were drag-reordered before this change, confirm the Researcher column stays exactly where the operator put it and does not jump to 110.
7. **Drag-reorder still works.** Drag Researcher to a new position in Setup and confirm both the board and its forward target follow — the re-weight must not have introduced a fixed position.
8. **Planner hand-off intact.** Trigger a planner run that flags an uncertain assumption and confirm the `advise_research` hand-off to `/research/dispatch` still fires. This plan does not touch that path; the check is to prove it.

## Recommendation

Complexity 4 — **Send to Coder.** Three one-liner edits across two hosts plus test updates; low-risk and pattern-reusing, but a cross-host forward-flow behaviour change. Land this BEFORE the companion terminal-sidebar plan so the sidebar's fallback constant mirrors `RESEARCHER` at `110`.
