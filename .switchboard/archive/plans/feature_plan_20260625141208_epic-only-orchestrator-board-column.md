# Epic-Only Orchestrator Column on the Kanban Board

## Goal

When a user presses Orchestrate on an epic, the epic card stays put in New/Planned — there is no on-board signal that it is in flight, and (per the recent "Orchestrator Role, No Board Column" decision) the orchestrator has no column at all. This plan adds a dedicated **Orchestrator column** to the board that an epic moves into when orchestrated, then flows out of like any normal coded work so it can still be reviewed.

The settled design (decided with the user):

- A new built-in column, **`ORCHESTRATING`** (display label "Orchestrator"), positioned **after all the coder lanes and immediately before CODE REVIEWED** (order ~250: LEAD CODED@180 / CODER CODED@190 / INTERN CODED@200 → **ORCHESTRATING@250** → CODE REVIEWED@300).
- It is a **normal pipeline column** for the epic that occupies it: the epic can be advanced, have its prompt copied, and be dragged forward. Advancing it goes to CODE REVIEWED, which dispatches the **reviewer** on the epic — i.e. *the epic still gets reviewed after orchestration*.
- It is **epic-only and strictly occupancy-gated**: it appears on the board **only when an epic actually occupies it**, and **no normal (non-epic) card may ever enter it** — not by drag, not by advancement, not by batch op.
- **Entry is the Orchestrate button only** ("teleport"), never by dragging any card in (epic or non-epic). The button already dispatches the orchestrator; moving the card into the column is a separate, non-dispatching status move.

### Core problem & root cause

The board's columns are data-driven from `DEFAULT_KANBAN_COLUMNS` (`src/services/agentConfig.ts` L102-115); each is a `KanbanColumnDefinition` (L70-81) with flags like `role`, `order`, `dragDropMode` (`'cli' | 'prompt' | 'disabled'`), and `hideWhenNoAgent`. There is currently **no orchestrator column** — the orchestrator role exists only as an Epics-tab button + a prompt-builder role. So an orchestrated epic has nowhere to live on the board.

The infrastructure to express the desired column already exists, but no single existing flag captures "epic-only + occupancy-only + never an auto-advance target" simultaneously:
- **Visibility:** `_filterDynamicColumns` (`KanbanProvider.ts` L2395-2408) hides a `hideWhenNoAgent` column unless its role's agent is visible **OR** a card occupies it. Because the orchestrator agent is hidden by default (`DEFAULT_VISIBLE_AGENTS.orchestrator = false`, confirmed `sharedDefaults.js` L18), a `role:'orchestrator' + hideWhenNoAgent:true` column is occupancy-only *by default* — but it would leak into view the moment a user enables the Orchestrator agent in the Agents tab (to edit its prompt). The user wants **strict** occupancy-only regardless of agent visibility.
- **Advancement:** `_getNextColumnId` (`KanbanProvider.ts` L3646-3700) walks columns by order and **skips** candidates where `shouldSkip` is true (L3660-3671: `dragDropMode==='disabled'`, or `hideWhenNoAgent && role && agent-hidden`, or inactive Acceptance Tested). This means a column inserted at order 250 is normally *not* diverted into — but again only while the orchestrator agent stays hidden.
- **Dispatch on move:** the real column→role map is `_columnToRole` (`KanbanProvider.ts` L7720-7733); it has no `ORCHESTRATING` case today.

**Root cause of the awkwardness:** the three behaviors the user wants are currently coupled to "is the orchestrator *agent* visible," which is the wrong axis. The fix is a single dedicated column flag — **`epicOnly`** — that drives all three enforcement points independently of agent visibility.

## Metadata

- **Tags:** frontend, backend, ui, ux, feature
- **Complexity:** 5/10

## User Review Required

None. The design (position before CODE REVIEWED, normal controls for the occupying epic, strict epic-only entry, button-teleport entry, advance-to-review exit) was decided with the user in the originating discussion.

## Complexity Audit

### Routine
- Add an `epicOnly?: boolean` field to `KanbanColumnDefinition` (`agentConfig.ts` L70-81).
- Add the `ORCHESTRATING` entry to `DEFAULT_KANBAN_COLUMNS` (L102-115) at `order: 250`, `role: 'orchestrator'`, `dragDropMode: 'cli'`, `epicOnly: true`, `kind: 'review'`.
- Add `case 'ORCHESTRATING': return 'orchestrator';` to `_columnToRole` (`KanbanProvider.ts` L7720).
- `buildKanbanColumns` (agentConfig L335-368) already spreads `...column` for default columns (L347-353), so `epicOnly` flows through the build pipeline to the webview's `updateColumns` payload (L6233-6236) without additional wiring.
- `_columnsSignature` (L2386-2393) only includes `id`, `label`, `role`, `autobanEnabled` — not `epicOnly`. This is fine: the signature is computed on the **filtered** list, so showing/hiding the Orchestrator column changes the filtered list and thus the signature, triggering `updateColumns`.

### Complex / Risky
- **Three enforcement points keyed off `epicOnly` (the core of the plan):**
  1. **Visibility (`_filterDynamicColumns`, L2402-2407):** an `epicOnly` column shows **iff occupied**, ignoring agent visibility — add `if (col.epicOnly) return occupiedColumns.has(col.id);` ahead of the existing logic.
  2. **Never an auto-advance target (`_getNextColumnId` → `shouldSkip`, L3660-3671):** add `if (col.epicOnly) return true;` so no card — epic or not — is ever auto-advanced *into* it (entry is the button only). This also guarantees normal coded cards at LEAD CODED/etc. advance straight to CODE REVIEWED regardless of orchestrator-agent visibility.
  3. **Reject foreign drops (move handler):** in the backend move/drop path that services drag and batch moves (around `moveCardToColumn` L4579 and the `_handleMessage` move case), reject any move of a non-epic card into an `epicOnly` column. This is the authoritative guard; the webview drop-target check is cosmetic on top of it.

- **`_isParallelCodedLane` is ID-based, not kind-based (verified).** `_isParallelCodedLane` (L3993-3997) hardcodes `'LEAD CODED' | 'CODER CODED' | 'INTERN CODED'` — it does **not** check `kind:'coded'`. Therefore `kind:'review'` for ORCHESTRATING is safe and will never trigger parallel-lane grouping. The original plan's concern about `kind:'coded'` triggering parallel-lane logic was unfounded; `kind:'review'` is the correct choice (matches the pattern used by RESEARCHER, PLAN REVIEWED, SPLITTER, CONTEXT GATHERER).

- **Three-layer guard for button-only entry.** Entry must be the Orchestrate button only — no drag, no batch, no integration. This requires guards at three layers:
  1. **`_resolveKanbanDispatchSpec` (L3947-3990):** return `null` for `epicOnly` columns. This prevents the orchestrator from being **dispatched** via drag-drop paths (`promptOnDrop` L5652, `triggerAction` L5174, `triggerBatchAction` L5293) and via Linear/ClickUp integration (`_remoteDispatchColumnAgent` L1509). The Orchestrate button bypasses `_resolveKanbanDispatchSpec` (it uses `buildEpicOrchestrationPrompt` L2985 + `switchboard.triggerAgentFromKanban`), so this guard does not block the button.
  2. **`moveCardToColumn` (L4579) + `moveCardToColumnByPlanFile` (L4610):** reject a move when the destination is `epicOnly` and the card is not an epic. This is the DB-level backstop covering all 28+ call sites of `moveCardToColumn` and the Linear path via `moveCardToColumnByPlanFile` (L1483). `moveCardToColumn` already fetches the plan record (L4590, `plan.isEpic`); `moveCardToColumnByPlanFile` fetches `previousRecord` (L4620, `previousRecord?.isEpic`).
  3. **Webview `handleDrop` (kanban.html L5608):** reject **all** drops onto `epicOnly` columns (both epic and non-epic — entry is button-only). The webview already stores full `columnDefinitions` (L6235) from `updateColumns`, so `epicOnly` is available client-side. This prevents the optimistic DOM move (L5838-5872) and the dispatch message from being sent, avoiding the visual snap-back glitch.

- **Advancing the epic OUT works unchanged:** from `ORCHESTRATING@250`, `_getNextColumnId` returns the next non-skipped column = `CODE REVIEWED@300` → dispatches `reviewer` on the epic. `_isParallelCodedLane('ORCHESTRATING')` returns false (ID-based), so the first branch (L3673) walks all columns after ORCHESTRATING, skips `epicOnly` candidates, and returns `CODE REVIEWED`. Confirm `_columnToRole('CODE REVIEWED')==='reviewer'` (L7727) — yes.

- **Entry = non-dispatching teleport.** The Orchestrate button must move the epic via the programmatic `moveCardToColumn` path (a DB/status update, no role dispatch), distinct from the drag-drop handler that dispatches — so orchestration is dispatched exactly once (by the button), not re-dispatched by the move.

- **`_remoteApplyColumnMove` dispatch-after-rejected-move (theoretical).** `_remoteApplyColumnMove` (L1482) calls `moveCardToColumnByPlanFile` then `_remoteDispatchColumnAgent` **regardless of whether the move succeeded**. If a Linear move somehow targeted ORCHESTRATING, the DB guard (#2) would reject the move, but `_remoteDispatchColumnAgent` would still fire. However, the `_resolveKanbanDispatchSpec` guard (#1) returns null for `epicOnly` columns, so `_remoteDispatchColumnAgent` (L1509-1510) would get `role=null` and return early (L1511-1514). In practice, Linear's status mapping does not include ORCHESTRATING, so this path is never hit. Defense in depth covers it.

## Edge-Case & Dependency Audit

**Epic-only enforcement must cover every entry path** (the hard requirement): (a) drag-drop, (b) `_getNextColumnId` advancement, (c) column-batch operations / "advance all in column," (d) Linear/ClickUp-driven column moves (`_remoteApplyColumnMove`, KanbanProvider L1482). All drag-drop paths route through `_resolveKanbanDispatchSpec` (guard #1) and `moveCardToColumn`/`moveCardToColumnByPlanFile` (guard #2). Batch-advance uses `_getNextColumnId` which skips `epicOnly` columns via `shouldSkip`. The webview guard (#3) prevents the optimistic DOM move and message send. Placing guards at these three layers covers all entry paths centrally.

**Optimistic UI snap-back:** the webview's `handleDrop` (L5608) performs an optimistic DOM move (L5838-5872) **before** sending the message to the backend. If the backend rejects the move (guard #2), the card visually moves and then snaps back on the next board refresh (L5284 `_scheduleBoardRefresh`). The webview guard (#3) prevents this entirely by rejecting the drop before the optimistic move. Without guard #3, the snap-back is a cosmetic glitch, not a data integrity issue (the DB is never updated).

**Migration (~4,000 installs on older versions):**
- New column added to `DEFAULT_KANBAN_COLUMNS` appears automatically on upgrade — no data migration; it is empty until an epic is orchestrated. No backfill of historical epics (forward-looking only).
- `kanban.orderOverrides` (user-reordered columns): the new column takes its default order 250 unless overridden; verify it inserts sanely for users who have customized order. `DEFAULT_CUSTOM_AGENT_KANBAN_ORDER` (agentConfig L117) is computed from max default order and is unaffected by an order-250 insert.
- Preserve unknown/legacy column-config keys; do not assume a prior migration ran.

**Board rendering:** the kanban board renders columns from the column definitions (data-driven via `updateColumns` message, L6233), so a new definition surfaces without hardcoded-column edits. Verified: `kanban.html` has no hardcoded board-column list for the board view (the hardcoded lists at L3733-3743 and L4487-4493 are for the Agents/Prompts tabs and the AUTOCODE synthetic column, not the board). The `columnDefinitions` array (L6235) carries full column objects including `dragDropMode` and (after this change) `epicOnly`, so the webview has everything it needs for guard #3.

**No confirmation dialogs** (project rule): rejected foreign drops should fail silently/with a non-modal status message, never a confirm gate.

**`epicOnly` field on `KanbanColumnDefinition`:** custom-user columns (L355-365) do not get `epicOnly` (it's only on built-in columns). The `buildKanbanColumns` spread (L347-353) preserves it for built-in columns. No need to add it to `CustomKanbanColumnConfig` (L61-68).

## Dependencies

- **Coordinates with `feature_plan_20260625110531_per-card-epic-action-buttons.md`** (per-card epic action buttons) and **`feature_plan_20260625110558_orchestrate-button-tooltip-and-state.md`** (Orchestrate button state) — the per-card Orchestrate button is the entry point that teleports the epic into `ORCHESTRATING`. This plan adds the column + enforcement; those plans own the button UI. Land them together.
- **Partially revisits** the "Orchestrator Role, No Board Column" decision (commit `5bc5957`) — intentionally, now that the column is epic-only and occupancy-gated rather than an always-present pipeline stage.
- **Context:** `feature_plan_20260625120812_slim-orchestrator-prompt-addons-epic-link.md` (the orchestrator prompt the button dispatches).

## Cross-Plan Coordination (this session)

- **Shared Orchestrate-button handler (↔ `…120812` slim prompt).** The per-card Orchestrate button must do, in one handler: build the terse orchestrator prompt (that plan) → dispatch it → `moveCardToColumn(…, 'ORCHESTRATING')` (this plan's non-dispatching teleport). Implement the two together so the handler isn't split or double-built.
- **Epic review picks up the project PRD (↔ `feature_plan_20260625143400_per-project-prd-and-projects-tab.md`).** Advancing the epic out of `ORCHESTRATING` → CODE REVIEWED dispatches the reviewer on the epic via a normal Switchboard dispatch, so (when project-context is on) the reviewer prompt carries the project PRD. Intended synergy: the epic is reviewed against its project's requirements. No action needed here — just don't special-case the epic out of normal dispatch on that hop.

## Adversarial Synthesis

Key risks: (1) drag-drop dispatches the orchestrator on a non-epic card before the DB guard rejects the move — mitigated by the `_resolveKanbanDispatchSpec` guard (returns null for `epicOnly` columns) and the webview `handleDrop` guard (rejects all drops onto `epicOnly` columns). (2) The Linear path uses `moveCardToColumnByPlanFile`, not `moveCardToColumn` — the original plan missed this; both methods now carry the guard. (3) Optimistic UI snap-back on rejected drops — mitigated by the webview-side guard that prevents the optimistic DOM move entirely. Mitigations form a three-layer defense-in-depth: dispatch-spec null, DB-level reject, webview-level reject.

## Proposed Changes

### File 1 — `src/services/agentConfig.ts`
1. Add `epicOnly?: boolean;` to `KanbanColumnDefinition` (L70-81).
2. Add to `DEFAULT_KANBAN_COLUMNS` (L102-115), between INTERN CODED and CODE REVIEWED:
   ```ts
   { id: 'ORCHESTRATING', label: 'Orchestrator', role: 'orchestrator', order: 250,
     kind: 'review', source: 'built-in', autobanEnabled: false,
     dragDropMode: 'cli', hideWhenNoAgent: true, epicOnly: true },
   ```
   `kind: 'review'` is confirmed safe — `_isParallelCodedLane` (L3993) is ID-based and does not check `kind`.

### File 2 — `src/services/KanbanProvider.ts`
3. `_columnToRole` (L7720): add `case 'ORCHESTRATING': return 'orchestrator';`.
4. `_filterDynamicColumns` (L2402): for `col.epicOnly`, return `occupiedColumns.has(col.id)` (occupancy-only, ignore agent visibility). Place this check **before** the existing `hideWhenNoAgent` logic so it takes precedence.
5. `_getNextColumnId` → `shouldSkip` (L3660): add `if (col.epicOnly) return true;` (never an auto-advance destination). Place this check early in `shouldSkip`, before the `dragDropMode` and `hideWhenNoAgent` checks.
6. **`_resolveKanbanDispatchSpec` (L3947-3990):** after finding the column (L3956), add `if (column.epicOnly) return null;` — this prevents dispatches to `epicOnly` columns via drag-drop and integration paths. The Orchestrate button bypasses this method, so it is unaffected.
7. **`moveCardToColumn` (L4579-4608):** after fetching the plan record (L4590), add a guard: if the target column is `epicOnly` and `!(plan && plan.isEpic)`, return `false`. To check `epicOnly`, either:
   - **Option A (pragmatic):** hardcode `if (targetColumn === 'ORCHESTRATING' && !(plan && plan.isEpic)) return false;` — simplest, since ORCHESTRATING is the only `epicOnly` column.
   - **Option B (generic):** export an `isEpicOnlyColumn(columnId: string): boolean` helper from `agentConfig.ts` that checks `DEFAULT_KANBAN_COLUMNS`, and call it here. More future-proof if more `epicOnly` columns are added.
   - **Recommended:** Option A for now; refactor to Option B if a second `epicOnly` column is ever added.
8. **`moveCardToColumnByPlanFile` (L4610-4637):** after fetching `previousRecord` (L4620), add the same guard: if the target column is `epicOnly` and `!(previousRecord && previousRecord.isEpic)`, return `false`. This covers the Linear/ClickUp integration path (`_remoteApplyColumnMove` L1483).
9. The Orchestrate button handler (in the per-card-button plan): after dispatching the orchestrator prompt (`buildEpicOrchestrationPrompt`, L2985-3030), call `moveCardToColumn(workspaceRoot, epicSessionId, 'ORCHESTRATING')` (non-dispatching teleport). Since the card IS an epic, the guard at step 7 passes.

### File 3 — `src/webview/kanban.html` (drop-target guard)
10. In `handleDrop` (L5608), before the optimistic DOM move and message dispatch, add an early check: look up the target column in `columnDefinitions` (L6235) and if `col.epicOnly` is true, reject the drop entirely (return early, no DOM move, no message sent). This enforces button-only entry at the UX layer and prevents the optimistic snap-back glitch.
    ```js
    // At the top of handleDrop, after resolving effectiveTargetColumn:
    const targetDef = columnDefinitions.find(c => c.id === effectiveTargetColumn);
    if (targetDef && targetDef.epicOnly) {
        // Entry is button-only — reject all drag-drops onto epic-only columns
        document.querySelectorAll('.kanban-card.selected').forEach(el => el.classList.remove('selected'));
        selectedCards.clear();
        return;
    }
    ```

## Verification Plan

### Automated Tests
- Add/adjust column-config and `_getNextColumnId`/`_filterDynamicColumns` unit coverage: `epicOnly` column is hidden when empty, shown when occupied (even with orchestrator agent enabled), never returned by `_getNextColumnId`, and rejects non-epic moves. (Run separately per session norm.)
- Add coverage for `_resolveKanbanDispatchSpec` returning null for `epicOnly` columns.
- Add coverage for `moveCardToColumnByPlanFile` rejecting non-epic cards into `epicOnly` columns.

### Manual Verification
1. Fresh board (no orchestrated epic): the Orchestrator column is **not** visible.
2. Enable the Orchestrator agent in the Agents tab: the column is **still not** visible (strict occupancy, decoupled from agent visibility).
3. Press Orchestrate on an epic: orchestrator dispatched once; the epic teleports into a now-visible Orchestrator column.
4. Try to drag a normal (non-epic) card into the Orchestrator column → rejected at the webview layer (no DOM move, no dispatch, no DB update).
5. Try to drag an epic card into the Orchestrator column from another column → rejected (button-only entry).
6. Advance a normal coded card from Lead Coder → it lands in CODE REVIEWED, skipping the Orchestrator column.
7. From the Orchestrator column, advance / drag the epic forward → it goes to CODE REVIEWED and the reviewer is dispatched on the epic.
8. Copy the epic's prompt from the Orchestrator column → it is the orchestrator prompt.
9. Last epic leaves the column → the column auto-hides.
10. Existing install upgrade: column appears empty/hidden; historical epics untouched; user column-order overrides still sane.

## Recommendation

Complexity 5/10 → **Send to Coder**. A column definition plus one new flag wired into five existing decision points (visibility filter, auto-advance skip, dispatch-spec null, DB-level move guard ×2 methods, webview drop guard). The care is in making the `epicOnly` guard authoritative across *all* move paths via three-layer defense-in-depth, and confirming the `kind`/parallel-lane interaction (verified: ID-based, not kind-based).

---

## Reviewer Pass (2026-06-25)

Direct in-place reviewer-executor pass. All proposed changes were located in the committed source and verified against the plan. The implementation is **complete and faithful to the plan's literal steps**. One genuine defense-in-depth/documentation gap was found and addressed with a non-behavioral corrective comment; no functional bug exists.

### Verification of implemented steps (all ✅)

| Step | Location | Status |
| :-- | :-- | :-- |
| `epicOnly?: boolean` on `KanbanColumnDefinition` | `agentConfig.ts:85` | ✅ |
| `ORCHESTRATING` column (order 250, kind `review`, role `orchestrator`, `dragDropMode:'cli'`, `hideWhenNoAgent`, `epicOnly`) | `agentConfig.ts:117` | ✅ |
| `buildKanbanColumns` spread preserves `epicOnly` | `agentConfig.ts:357` | ✅ |
| `_columnToRole` → `'orchestrator'` | `KanbanProvider.ts:8026` | ✅ |
| `_filterDynamicColumns`: `epicOnly` ⇒ occupancy-only, placed **before** `hideWhenNoAgent` | `KanbanProvider.ts:2411` | ✅ |
| `_getNextColumnId`/`shouldSkip`: `epicOnly` ⇒ skip, placed **first** | `KanbanProvider.ts:3785` | ✅ |
| `_resolveKanbanDispatchSpec`: `epicOnly` ⇒ `null` | `KanbanProvider.ts:4092` | ✅ |
| `moveCardToColumn` rejects non-epic → ORCHESTRATING (Option A) | `KanbanProvider.ts:4726` | ✅ |
| `moveCardToColumnByPlanFile` rejects non-epic → ORCHESTRATING (Option A) | `KanbanProvider.ts:4772` | ✅ |
| Webview `handleDrop` rejects drops onto `epicOnly` columns | `kanban.html:5692` | ✅ |

Independently confirmed: `_isParallelCodedLane` is ID-based (`KanbanProvider.ts:4128`) so `kind:'review'` is safe; advance-OUT resolves `_columnToRole('CODE REVIEWED') === 'reviewer'`; `_columnsSignature` is computed on the **filtered** list (`KanbanProvider.ts:2173/2329/1275`) so show/hide of ORCHESTRATING re-emits `updateColumns`; `'ORCHESTRATING'` passes the DB column validator via `SAFE_COLUMN_NAME_RE` (`KanbanDatabase.ts:624`) exactly like the other non-allowlisted built-ins (RESEARCHER/SPLITTER/etc.).

### Findings

**CRITICAL** — none.

**MAJOR (M1) — Dispatch guard #1 does not block dispatch as the plan's prose claims (defense-in-depth gap, no functional impact).**
The plan (L52/L60/L92) states that `_resolveKanbanDispatchSpec` returning `null` for `epicOnly` columns prevents the orchestrator from being *dispatched* on foreign cards, and specifically (L60) that `_remoteDispatchColumnAgent` "would get `role=null` and return early." That is **false**: every dispatch caller resolves the role as `dispatchSpec?.role || this._columnToRole(targetColumn)` (`KanbanProvider.ts:1516`, `:5393`, `:5512`), and `_columnToRole('ORCHESTRATING')` returns `'orchestrator'` (`:8026`), so the `||` fallback rescues the role and dispatch would proceed (subject only to `_canAssignRole`). The null return only strips the *spec-driven custom-user* dispatch config; it is **not** the gate it is described as.
- **Why there is no functional bug today:** every reachable entry path is independently blocked — drag is rejected by webview guard #3 (`kanban.html:5692`) *before any dispatch message is sent*; batch/auto-advance never returns ORCHESTRATING (`shouldSkip`, `:3785`); and no Linear status maps to ORCHESTRATING (so `_remoteApplyColumnMove` is never called with it). Data integrity is fully protected by the DB guards #2 (`:4726`/`:4772`), which are the authoritative layer and work correctly.
- **Why the code was NOT changed to "fix" it:** the `_columnToRole('ORCHESTRATING') === 'orchestrator'` mapping is *required* for the legitimate path where an epic already parked in ORCHESTRATING receives an inbound Linear comment and is re-dispatched (`_remoteDispatchComment` → `_remoteDispatchColumnAgent`). A blanket dispatch block on ORCHESTRATING would break that. A truly correct backend dispatch gate would need an `isEpic`-aware check at three call sites — all of which are *unreachable* for ORCHESTRATING today, making the change dead code. A naive `if (!moved) return;` in `_remoteApplyColumnMove` (`:1488`) would change re-dispatch behavior for **all** Linear moves (redundant-webhook re-dispatch), a disproportionate regression risk for a path that cannot be hit.
- **Fix applied:** a corrective comment at the `_resolveKanbanDispatchSpec` `epicOnly` guard (`KanbanProvider.ts:4092`) documenting that the null return is *defense-in-depth, not the gate*, and naming the three real gates — so a future maintainer does not trust the misleading premise. **Tripwire:** if a future change ever makes ORCHESTRATING a reachable backend dispatch target (a Linear status→ORCHESTRATING mapping, or any non-drag programmatic dispatch), an `isEpic`-aware guard MUST be added to the dispatch role resolution; the current null return will not stop it.

### NITs (no action taken)

- **N1 — Webview guard placement.** Implemented at the very top of `handleDrop` keyed on `targetColumn` (`kanban.html:5692`) rather than after `effectiveTargetColumn` as the plan snippet showed. Functionally identical (the only divergence between the two is the `CREATED`→`BACKLOG` backlog remap, and neither is `epicOnly`) and placing it earlier is marginally safer. Keep.
- **N2 — Markdown state export.** `exportStateToFile` (`KanbanDatabase.ts:5308`) iterates `VALID_KANBAN_COLUMNS`, which omits ORCHESTRATING — so an epic parked there won't appear in the generated `Kanban Board` markdown dump. This is a **pre-existing** pattern (RESEARCHER/SPLITTER/INTERN CODED/ACCEPTANCE TESTED/TICKET UPDATER are already omitted), cosmetic, and not introduced by this plan. No change.
- **N3 — Option A hardcoding.** Both DB guards check the literal `'ORCHESTRATING'` string rather than the `epicOnly` flag (as the plan recommended for now). If a second `epicOnly` column is ever added, these guards silently won't cover it — refactor to the `isEpicOnlyColumn()` helper (plan Option B) at that point. Acknowledged in the plan.

### Cross-plan dependency (not a defect of this plan)

The Orchestrate-button **teleport** (`moveCardToColumn(…, 'ORCHESTRATING')`, plan step 9) is **not present in this codebase** — it is correctly scoped to the sibling plan `feature_plan_20260625110531_per-card-epic-action-buttons.md`. Consequence: **this plan's column is inert until that plan lands** (the column has no occupant, so it never becomes visible). This matches the plan's own Dependencies note ("Land them together") and is expected, not a bug in this implementation.

### Validation

- **Typecheck/compile:** skipped per session directive (SKIP COMPILATION).
- **Tests:** skipped per session directive (SKIP TESTS) — run separately by the user. The Verification Plan's automated-test additions remain TODO for that run.
- **Static review:** all 10 proposed changes located and verified in committed source; all enforcement-point placements confirmed correct relative to surrounding logic.

### Remaining risks

1. **M1 defense-in-depth gap** (above): zero functional impact today; mitigated by webview guard #3 + `shouldSkip` + absence of Linear mapping + authoritative DB guards #2. Tripwire documented for future dispatch-target changes.
2. **Inertness until the sibling button plan lands** (cross-plan dependency): the column cannot appear until the teleport exists. Land both together as the plan directs.
3. **Test coverage outstanding**: the unit coverage described in the Verification Plan (occupancy visibility, `_getNextColumnId` skip, dispatch-spec null, non-epic move rejection) has not been added/run in this pass.
