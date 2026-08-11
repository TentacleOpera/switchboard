# Standalone Kanban Column-Parity Audit

## Goal

Audit every standalone-host kanban column/verb behavior against its extension-host equivalent, classify each as parity / diverges / editor-only, and close the divergences — so adding a new built-in column (like DISPATCH) does not require a per-column standalone fix to keep the two hosts in sync.

> **Goal-statement note (flagged, NOT edited — factual context is preserved verbatim per the improve-plan content-preservation rule).** The parenthetical "(like DISPATCH)" is stale against HEAD. `DISPATCH` is **not** a built-in column: it is a *display mode* of `PLAN REVIEWED`, declared in `DISPLAY_MODE_COLUMNS` (`src/services/agentConfig.ts:150-153`) whose own doc comment states such IDs "MUST NOT appear in `DEFAULT_KANBAN_COLUMNS`". `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:132-143`) contains exactly ten entries and no `DISPATCH`. That decision was taken deliberately in `dispatcher-column-and-bounce-analysis.md` ("What changed from the previous revision → The peer column"), precisely so `DISPATCH` would never enter `_getNextColumnId`'s ordered walk. So DISPATCH will never reach either next-column resolver and is not the trigger for this audit. **The audit's substance survives intact** — the standalone/extension divergence is real, confirmed, and firing today at factory defaults (see Root Cause below); it is triggered by *agent visibility*, *custom columns*, and *order overrides*, not by DISPATCH. The user should decide whether to reword the Goal; the audit proceeds either way.

### Problem

The Standalone Board Parity feature (`standalone-board-parity-aa872dcc`) wired the `default:` verb fallthrough and fixed silent settings/command failures, but it deliberately left the **explicit-case verbs** in `bootstrap.ts`'s hand-written switch alone — `moveSelected`, `promptSelected`, and the `triggerAction` dispatch path all call `getNextKanbanColumn`, a hardcoded map that duplicates the extension's `_getNextColumnId` logic with no visibility awareness and no awareness of columns added after the map was written. The parity feature's triage classified these as "works" because they return `{success: true}` and move cards — the divergence is behavioral, not functional, and only manifests when a new column lands between existing ones (DISPATCH is the first).

### Root Cause

Two independent next-column resolution implementations exist: `_getNextColumnId` (KanbanProvider, walks `_buildKanbanColumns()` in order with `shouldSkip` visibility/feature-only/disabled gating) and `getNextKanbanColumn` (bootstrap.ts, a static `Record<string,string>` map with no gating). The parity feature unified verb *routing* (the `default:` arm) but not verb *logic* (the explicit cases that carry their own column-resolution). Any column-aware behavior authored in the extension must be manually mirrored in the standalone map, and there is no test or gate that detects the drift.

### Root Cause — corrected and widened (verified at HEAD)

> **Superseded:** "Two independent next-column resolution implementations exist" — and the implied conclusion that replacing `getNextKanbanColumn` with a shared `_getNextColumnId` extraction closes the parity gap.
> **Reason:** There are **three** resolvers, not two, and next-column resolution is the *smallest* of the divergences. The standalone explicit cases fork far more than column resolution: complexity routing, feature cascade, run-sheet recording, the CLI-triggers gate, dispatch-spec resolution, and completion status are all missing. Fixing only the resolver makes the audit's own success check go green while `moveSelected` still behaves nothing like the extension's — the exact "passes its own metric, misses the goal" failure.
> **Replaced with:** The root cause is that **`bootstrap.ts` forks board logic on two axes at once**, and each fork has its own correct fix:
>
> **Axis 1 — the verb fork (write path).** `bootstrap.ts:854-1171` hand-writes 18 verb cases above a `default:` arm that already delegates every other verb to `kanbanProvider.handleServiceVerb`. Each hand-written case is a partial reimplementation of a much larger provider arm. `getNextKanbanColumn` is one symptom; there are at least six others of equal or greater severity (see the classification table).
>
> **Axis 2 — the push fork (read path).** `bootstrap.ts:381-440` hand-assembles the board payload from literals — `columns: DEFAULT_KANBAN_COLUMNS` (raw, unfiltered), `cliTriggersState.enabled: false`, `routingConfig: {}` — while `KanbanProvider.getFullStateMessages` (`KanbanProvider.ts:1124-1227`) already builds the correct payload and is **public, documented for exactly this use** ("Full-state message list for a browser WS resync (cockpit)… Fall back to the passed root (**standalone**, or before any selection)"). The extension host's own browser route calls it (`TaskViewerProvider.ts:2513`); standalone does not.
>
> The third resolver is client-side: `getNextColumn` in `src/webview/kanban.html:5169-5173` is a naive `columns[idx + 1]` over the **pushed** column list. It is correct-by-construction *when the pushed list is correct*. That is the load-bearing insight of this audit: the browser board does not need a shared next-column function — it needs the **right column list pushed to it**. Axis 2 is therefore not a cosmetic render issue; it is a *behavioral* one, because the client gates its own pipeline buttons on `if (!nextCol) return;` (`kanban.html:5817`).

### Confirmed live divergences (verified against HEAD, factory defaults)

Default agent visibility (`KanbanProvider._getVisibleAgents`, `KanbanProvider.ts:6293-6303`) is `tester: false`, `ticket_updater: false`, `researcher: false`. `_isAcceptanceTesterDesignDocConfigured()` returns a hardcoded `true` (`KanbanProvider.ts:11703-11705`), so `acceptanceTesterActive === (visibleAgents.tester !== false)` → **false** at defaults.

1. **`CODE REVIEWED` advances into a hidden column in standalone.** The extension returns `null` (the `normalizedColumn === 'CODE REVIEWED' && candidate.id === 'COMPLETED' && !acceptanceTesterActive` guard, `KanbanProvider.ts:5837-5839`, after `ACCEPTANCE TESTED` is skipped) — the move is refused. The standalone map returns `'ACCEPTANCE TESTED'` unconditionally (`bootstrap.ts:138`), so a browser "move all from Reviewed" pushes every card into a column the extension host does not render. Regression-tested by `KanbanProvider.test.ts:176-180` on the extension side; nothing tests the standalone side. **This fires at factory defaults — no configuration required.**
2. **`moveAll` is dead in standalone.** `kanban.html:5858` posts `{ type: 'moveAll', column }` with **no `sessionIds`**. The standalone arm shares its body with `moveSelected` and hard-requires them (`bootstrap.ts:899-901`), so it returns `{success:false, error:'Missing column or sessionIds'}` every time. The extension's `moveAll` (`KanbanProvider.ts:9237-9247`) resolves the cards from the column itself. Note `promptAll` *does* handle the empty case (`bootstrap.ts:935-938`) — the asymmetry confirms this is an oversight, not a design.
3. **`PLAN REVIEWED` batches skip complexity routing entirely in standalone.** The extension partitions by complexity into lead/coder/intern lanes (`_partitionByComplexityRoute`, `KanbanProvider.ts:7106`; `_targetColumnForDispatchRole`, `:7208`) inside both `moveSelected` (`:9110-9155`) and `moveAll` (`:9253-…`). Standalone sends the whole batch to whatever the map says (`LEAD CODED`). Every low-complexity plan is misrouted to the Lead Coder.
4. **The CLI-triggers gate does not exist in standalone, and the board is told it is off.** The extension gates dispatch on `this._cliTriggersEnabled` (`KanbanProvider.ts:9147`, `:8159`); standalone gates on `ptyReady && isDispatchColumn` (`bootstrap.ts:912-916`) — a different predicate — while simultaneously broadcasting `cliTriggersState: { enabled: false }` as a literal (`bootstrap.ts:407`, `:436`). The board renders "triggers off" and then dispatches anyway.
5. **Completion never sets `status`.** `moveSessionsToColumn` (`bootstrap.ts:842-852`) only calls `db.updateColumn` / `db.cascadeFeatureByPlanId`. The extension's `completePlan` also calls `db.updateStatus(sessionId, 'completed')` and regenerates the feature file (`KanbanProvider.ts:9765-9775`). A standalone-completed plan stays `status='active'`, so it never enters `getCompletedPlansInHotWindow` and is never subject to `kanban.completedLimit` pruning. Standalone also cannot resolve a card by `planId` — `kanban.html:6653` sends `{sessionId, planId}` and the extension resolves via `_resolveSessionId(planId, sessionId)`; standalone reads `payload.sessionId` only (`bootstrap.ts:972`).
6. **The board renders columns the extension hides.** `bootstrap.ts:405`/`:434` push raw `DEFAULT_KANBAN_COLUMNS` (all ten). The extension pushes `_filterDynamicColumns(builtColumns, visibleAgents, cards)` (`KanbanProvider.ts:1161`, filter body at `:3854-3866`) — hidden-role columns survive only if they still hold cards. At factory defaults the browser shows ten columns where the editor shows seven, and custom columns / order overrides never appear at all.
7. **`moveSessionsToColumn`'s `sourceColumn` parameter is dead.** Declared at `bootstrap.ts:842`, never read in the body. Every call site passes one; none of them can affect anything. It is the residue of the move-validation the extension does via `moveCardToColumn` + `moveCardsFailed` reporting.

## Background

The standalone host (`src/standalone/bootstrap.ts`) drives the same shared board HTML as the extension. The parity feature established that the `default:` arm delegates to `KanbanProvider.handleServiceVerb`, but the hand-written cases above it (`moveSelected` ~817, `promptSelected` ~846, `triggerAction` dispatch ~1241) retain standalone-specific logic. Three call sites use `getNextKanbanColumn` (line 128): a 9-entry hardcoded map with no `DISPATCH` entry and no visibility check. The extension's `_getNextColumnId` (KanbanProvider:5687) walks the built column list in order and applies `shouldSkip` (skips `featureOnly`, hidden roles via `visibleAgents[role]===false`, `dragDropMode==='disabled'`, inactive ACCEPTANCE TESTED). The standalone map cannot replicate this because it receives only `sourceColumn` — it has no access to `visibleAgents`, custom columns, or column ordering.

`getNextKanbanColumn` is not the only candidate divergence. The `isDispatchColumn` check at bootstrap:834 (`dragDropMode === 'cli' && !!targetDef.role`) determines whether `moveSelected` dispatches to a terminal or moves-only; the extension's equivalent lives inside the `moveCardForward` handler in KanbanProvider and may use different criteria. Any hardcoded lookup, column-order assumption, or visibility check in bootstrap that duplicates extension logic is a parity hazard.

### Background — citation corrections verified at HEAD (2026-08-09)

The Background above is preserved verbatim; its line numbers and one symbol name have drifted. Use these when coding:

| Background says | Actual at HEAD |
|---|---|
| `moveSelected` ~817 | `bootstrap.ts:895-922` (`getNextKanbanColumn` call at `:902`) |
| `promptSelected` ~846 | `bootstrap.ts:924-954` (call at `:929`) |
| `triggerAction` dispatch ~1241 | `bootstrap.ts:1336-1425`, inside `handlePtyVerb` (call at `:1363`) |
| `getNextKanbanColumn` (line 128) | `bootstrap.ts:130-143`; a **9**-entry map (correct count) |
| `isDispatchColumn` at bootstrap:834 | `bootstrap.ts:912` |
| `_getNextColumnId` (KanbanProvider:5687) | `KanbanProvider.ts:5798-5857` |
| the extension's equivalent "lives inside the `moveCardForward` handler" | **No `moveCardForward` handler exists.** The equivalent gating is `_resolveKanbanDispatchSpec` (`KanbanProvider.ts:6096`) + `_cliTriggersEnabled` (`:9147`, `:8159`) + `_canAssignRole` (`:6344`), spread across the `moveSelected`/`moveAll`/`triggerAction` arms. |
| (Implementation §4) `TaskViewerProvider._filterVisibleColumns` as the board's visibility filter | `_filterVisibleColumns` (`TaskViewerProvider.ts:3873-3885`) exists but feeds the **Setup panel's** column structure, not the board push. The board push filter is `KanbanProvider._filterDynamicColumns` (`:3854-3866`), which additionally keeps a hidden column alive while it still holds cards. |

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Audit scope | All explicit-case verbs in bootstrap's `kanbanVerb` switch + all standalone helper functions that duplicate extension column logic | The parity feature covered the `default:` arm; this audit covers everything it deliberately left alone. |
| Classification | parity / diverges / editor-only (same four-outcome scheme as the parity feature's triage) | Reuses the established vocabulary; "editor-only" means legitimately vscode-bound, not a defect. |
| Fix strategy | Close small divergences in-plan; spawn follow-on plans for any fix touching 3+ files or requiring architectural change | Keeps the audit deliverable bounded; avoids a mega-plan. |
| `getNextKanbanColumn` fix | **See superseded callout below.** | |
| Test gate | A parity test that asserts standalone and extension resolve the same next-column for every built-in column ID, across visible/hidden states | Prevents future drift; the absence of this gate is why DISPATCH exposed the gap. |

> **Superseded:** "`getNextKanbanColumn` fix — Replace the hardcoded map with a call into the shared `_getNextColumnId` logic (or a standalone-callable extraction of it). Eliminates the duplicate implementation entirely — the root cause — rather than patching the map per-column."
> **Reason:** Three problems. (1) It builds a *new* shared abstraction to serve a caller that should not exist — the standalone arms that call it are themselves forks of provider arms that already call `_getNextColumnId` correctly. (2) It requires surgery on `KanbanProvider`'s internals (`_getCustomAgents` / `_getVisibleAgents` / `_buildKanbanColumns` / `_isAcceptanceTesterDesignDocConfigured` are all instance methods with state), which is the one part of this change that carries shipped-install risk under PRD contract #2 — for zero benefit to the extension. (3) It fixes 1 of the 7 confirmed divergences and leaves complexity routing, cascade, run-sheets, the CLI-triggers gate and the dispatch spec broken, while making the plan's own verification pass. That is the goal-vs-appearance failure this plan exists to avoid.
> **Replaced with:** **Delete the fork on both axes; add no new abstraction.**
> - **Axis 1:** delete the `moveSelected`/`moveAll`, `promptSelected`/`promptAll`, `completePlan`/`completeSelected` and `chatCopyPrompt` cases from `bootstrap.ts` so they fall through to the existing `default:` arm, which already routes to `kanbanProvider.handleServiceVerb` → the real provider arms. PTY dispatch continues to work unchanged because those arms dispatch via `executeCommand('switchboard.triggerAgentFromKanban' | 'switchboard.triggerBatchAgentFromKanban')`, and **standalone already registers both commands** (`bootstrap.ts:826-837`) with handlers that forward to `handlePtyVerb('triggerAction', …)`. The delegation path is already proven in this file: `createFeature` / `promoteToFeature` / `addSubtaskToFeature` (`bootstrap.ts:1116-1122`) delegate exactly this way and are guarded by a contract test.
> - **Axis 2:** replace the hand-assembled `pushFullState` / `getFullState` payloads with `kanbanProvider.getFullStateMessages(workspaceRoot, scope)` — the public method built for this, already used by the extension host's browser route.
> - `getNextKanbanColumn` and `getRoleForTargetColumn` are then **deleted with no replacement**: nothing in bootstrap resolves columns any more. `_getNextColumnId` stays private and untouched, so contract #2 exposure drops to zero.
>
> **Prerequisite this exposes (must be done first, not discovered mid-code):** `moveAll` and `promptAll` read `this._lastCards` via `_visibleColumnCards` (`KanbanProvider.ts` — `_visibleColumnCards` body filters `_lastCards`), and `_lastCards` is only ever assigned by the editor refresh path (`KanbanProvider.ts:1990`), which standalone never runs. Delegating those two verbs without priming `_lastCards` swaps "silently wrong" for "silently empty". Prime it from the standalone board build — `getFullStateMessages` computes the cards already; assign them to `_lastCards` on the standalone side (`(kanbanProvider as any)._lastCards = cards`) rather than adding an assignment inside the shipped provider.

### Design decision — why not simply keep two implementations in sync

Rejected. It is the status quo with a test bolted on. A test that pins two implementations together still requires every future column-behaviour change to be authored twice; the test converts silent drift into a red build, which is better, but the second implementation keeps earning its maintenance cost forever. Deletion removes the cost and the test surface both.

## Metadata

**Tags:** backend, refactor, reliability, api
**Complexity:** 7
**Project:** Browser Switchboard

## User Review Required

> **Superseded:** "`getNextKanbanColumn` replacement strategy. Two options: (a) extract `_getNextColumnId`'s core into a standalone-callable function…; (b) replicate the `shouldSkip` logic inline in bootstrap… Recommendation: (a)."
> **Reason:** Both options preserve a standalone column resolver. Verification at HEAD shows no standalone caller should exist at all — the arms that call it are forks of provider arms that already resolve columns correctly. Choosing between (a) and (b) is choosing which duplicate to keep.
> **Replaced with:** the delegation decision below.

Yes — one decision:

- **Delegate the forked verbs, or fix them in place?** *(a)* Delete the `moveSelected`/`moveAll`, `promptSelected`/`promptAll`, `completePlan`/`completeSelected`, `chatCopyPrompt` cases so they fall through to the `default:` arm and run the real provider arms — closes all seven confirmed divergences at once, deletes ~110 lines, adds no abstraction, but the standalone host's behaviour on those verbs changes wholesale in one step (complexity routing, run-sheet writes, cascade collection and the CLI-triggers gate all begin firing where they previously did not). *(b)* Keep the cases and patch each divergence in place — smaller blast radius per step, but preserves the fork and every one of these findings recurs on the next provider change. **Recommendation: (a).** The standalone host is unreleased dev work (PRD phase B1/B2, `npx` distribution is B4), so the migration rule permits a clean break — no shipped state to migrate, and contract #2's byte-compat obligation binds the *extension* provider, which (a) does not touch. Confirm before coding.

## Complexity Audit

### Routine
- Enumerating bootstrap's explicit-case verbs and their extension equivalents (done in this pass — see the classification table under Implementation §1).
- Deleting `getNextKanbanColumn` (`bootstrap.ts:130-143`) and `getRoleForTargetColumn` (`:145-148`) once no caller remains.
- Deleting the dead `sourceColumn` parameter from `moveSessionsToColumn` (`bootstrap.ts:842`), or deleting the helper outright if delegation removes its last caller.
- Swapping the two hand-assembled payloads for `getFullStateMessages`.

### Complex / Risky
- **`_lastCards` priming.** `moveAll` / `promptAll` resolve their card set from `_lastCards`, which standalone never populates. Delegating without priming turns a wrong answer into an empty one — and `moveAll` returns a *plausible* `{success:false, error:'No plans in <column> to move.'}`, which reads like correct behaviour on an empty column. This is the single highest-risk item in the plan.
- **Behaviour change on delegation.** Complexity routing, `recordRunSheetForColumnMove`, `_collectAllMovedSessionIds` cascade, `moveCardsFailed` reporting and the `_cliTriggersEnabled` gate all start firing in standalone. Each is *correct* (it is what the extension does) but each is new behaviour for the browser board, and `_cliTriggersEnabled` defaults to `true` (`KanbanProvider.ts:441`) while the standalone push currently claims `false` — the board's own toggle state must be sourced from `getFullStateMessages` in the same change or the UI and the gate will disagree in the opposite direction.
- **`getFullStateMessages` under the vscode shim.** It calls `vscode.workspace.getConfiguration('switchboard.activityLight')` (`KanbanProvider.ts:1150`), `this._getWorkspaceItems()` (→ `this._seams().workspace.getWorkspaceRoots()`), `getControlPlaneSelectionStatus`, and `_resolveProjectContextEnabled`. Each must be exercised against the standalone seam bundle before the swap is trusted; a shim returning `[]` from `getWorkspaceRoots()` would empty the board's workspace dropdown.
- **DB instance identity.** `getFullStateMessages` resolves its DB via `_getKanbanDb(root)` → `KanbanDatabase.forWorkspace(root)`, which is instance-cached per resolved root (`KanbanDatabase.forWorkspace`, early `_instances.get(stable)` return). Bootstrap's own `db` (`bootstrap.ts:325`) is built the same way, so this is the **same** instance — no second sql.js handle on one file. Verify this holds if `db-pointer` or `kanban.dbPath` redirection is in play, since a divergent resolved path would open a second handle.
- **Regression risk on shipped installs (contract #2).** Materially reduced by this approach — the extension provider is read, not modified. The one residual touchpoint is the `_lastCards` priming, which must be done from the standalone side (a cast assignment in `bootstrap.ts`) and not by adding an assignment inside `getFullStateMessages`, which the editor path also calls.

## Edge-Case & Dependency Audit

**Race Conditions**
- Column resolution itself is synchronous within a verb handler. The real race is the **push/verb ordering**: the coalesced `schedulePushFullState` (40 ms trailing edge, `bootstrap.ts:459-471`) fires after the verb returns. Delegated arms also emit their own `moveCards` deltas via `postMessage`. In standalone, `KanbanProvider.postMessage` reaches the WS hub only because `_broadcaster` is assigned (`bootstrap.ts:758`) — deltas that were previously emitted by hand from the bootstrap arms will now come from the provider. Verify no verb emits a `moveCards` delta *and* a full-state push that disagree.
- `_lastCards` priming introduces a staleness window: a card moved by an agent between the last push and a `moveAll` click is resolved from the primed snapshot. The extension has the identical window by design (`KanbanProvider.ts:9243-9246` documents deliberately not re-refreshing) — parity, not a new defect.

**Security**
- None new. All verbs already traverse `verbSchemas.ts` validation at the HTTP boundary (PRD contract #5); delegation moves work *behind* the same boundary, it does not widen it. Confirm the delegated verbs' schemas already exist and are permissive enough for the webview payloads (`moveAll` sends `{column}` only — a schema requiring `sessionIds` would reject a valid payload, which is itself a contract-#5 regression).

**Side Effects**
- Delegation makes `recordRunSheetForColumnMove` and `_regenerateFeatureFile` fire in standalone for the first time. Both write to disk. Confirm the run-sheet writer and feature-file regenerator have working standalone paths (the feature-file regenerator is already wired — `bootstrap.ts:763-765`).
- Replacing the push payload changes what the browser board renders (fewer columns at defaults, real `routingConfig`, real `cliTriggersState`). Anything client-side keyed on the current always-ten-columns behaviour will change — notably `getNextColumn` (`kanban.html:5169`) and the `if (!nextCol) return;` button gate (`:5817`), which is the intended fix, and `resolveDomColumn` / the backlog+dispatch display-mode remaps, which must still find their slots.
- The parity feature's review noted `featureManagement: true` was over-reporting and was fixed; verify that fix still holds and isn't re-broken by these changes.

**Dependencies & Conflicts**
- Depends on the Standalone Board Parity feature having landed (it has — all 6 subtasks CODE REVIEWED). The `default:` fallthrough and command bridge are prerequisites for any standalone verb work — and under the replacement approach the `default:` arm is not merely a prerequisite, it is the fix vehicle.
- **Conflict with `dispatcher-column-and-bounce-analysis.md` is now void.** That plan's current revision makes `DISPATCH` a display mode with no `DEFAULT_KANBAN_COLUMNS` entry and no `getNextKanbanColumn` entry, so the two plans no longer touch a shared fix site. The previously-stated sequencing constraint no longer applies.
  > **Superseded:** "Conflicts with the dispatcher plan on the `getNextKanbanColumn` fix site — both touch it. Sequencing: this audit plan should land first…"
  > **Reason:** The dispatcher plan's peer-column revision was cut; its current text explicitly states a display mode "has no `order` and is not in `DEFAULT_KANBAN_COLUMNS`, so it never enters the walk," which removes its need to touch the standalone map.
  > **Replaced with:** No conflict. Either order is safe. The dispatcher plan's own hard prerequisite (`restore-backlog-view-to-standalone-host.md`) overlaps this plan's Axis 2 — if this plan lands the `getFullStateMessages` swap first, that prerequisite's `showingBacklog` literal removal is subsumed. Coordinate so the two do not both rewrite `pushFullState`.
- `verbSchemas.ts` is shared — this plan adds NO new verbs, so no schema append. It may require *loosening* an existing schema (see Security above).
- PRD orchestration discipline: `bootstrap.ts` is a single file and takes a single agent stream. Do not parallelise Axis 1 and Axis 2 across agents.

## Dependencies

- `standalone-board-parity-aa872dcc` — all 6 subtasks CODE REVIEWED. The `default:` fallthrough and command bridge are prerequisites.
- `restore-backlog-view-to-standalone-host.md` — overlapping fix site (`pushFullState` literals). Not a hard blocker; sequence to avoid a double rewrite.

## Adversarial Synthesis

Key risks: (1) delegation is the correct fix but changes standalone behaviour on seven verbs at once — `_lastCards` is unprimed, so `moveAll`/`promptAll` would return a *plausible* "no plans in column" instead of working, and that failure reads as correct on an empty board; (2) the `getFullStateMessages` swap depends on four provider helpers behaving under the vscode shim (`getConfiguration`, `getWorkspaceRoots`, control-plane status, project-context) and a shim returning empty would blank the workspace dropdown rather than error; (3) the audit's original success check — "grep bootstrap for `getNextKanbanColumn`, expect zero" — is satisfiable while six of seven divergences remain, so the verification plan, not the fix, was the real defect. Mitigations: prime `_lastCards` from the standalone side before delegating (never inside the shipped provider); land Axis 2 (push) before Axis 1 (verbs) so the board's column list is already correct when the provider arms start resolving against it; and replace the grep-based verification with behavioural assertions that name the specific divergent outcomes (CODE REVIEWED → null, `moveAll` with no `sessionIds`, PLAN REVIEWED complexity split).

## Implementation

### 1. Enumerate and classify — **completed in this pass**

**File:** `src/standalone/bootstrap.ts` (read-only audit)

Every non-`default:` case in the `kanbanVerb` switch (`bootstrap.ts:854-1171`) and the standalone helpers, against its extension equivalent. Classification: **parity** (same logic, same outcome) / **diverges** (different logic or outcome) / **editor-only** (legitimately vscode-bound) / **degrade-by-design** (headless-honest per PRD contract #6).

| Standalone case | bootstrap.ts | Extension equivalent | Class | Note |
|---|---|---|---|---|
| `ready`, `refresh` | 858-861 | `KanbanProvider.ts:7452`, `:7570` | **diverges** | Pushes the literal payload (Axis 2). |
| `selectWorkspace` | 863-867 | `:7732` | parity (bounded) | Standalone is single-root by construction; the no-op-on-mismatch is honest. |
| `setProjectFilter` | 869-873 | `:7910` | **diverges** | Standalone stores a module-local `projectFilter`; the extension persists a scoped setting. Survives no restart. |
| `addProject` | 877-884 | `:7807` | likely parity | Thin `db.addProject`; confirm the extension arm adds no side effects. |
| `deleteProject` | 886-893 | `:7881` | likely parity | Same. |
| `moveSelected`, `moveAll` | 895-922 | `:9102`, `:9237` | **diverges — severe** | No complexity routing, no cascade, no run-sheet, no dispatch spec, no CLI gate; `moveAll` cannot run at all (finding 2). |
| `promptSelected`, `promptAll` | 924-954 | `:9421`, `:9545` | **diverges** | Uses `buildPromptForCards` + `getRoleForTargetColumn` instead of `_generatePromptForColumn` (`:5862`), which resolves the *destination* role and custom-column roles. |
| `chatCopyPrompt` | 956-968 | `:9379` | **diverges** | Extension routes through `_cardsToPromptPlans` + `generateUnifiedPrompt`; standalone hardcodes role `'analyst'` and a 20-row `getBoard` slice. |
| `completePlan`, `completeSelected` | 970-978 | `:9754`, `:9784` | **diverges** | No `updateStatus('completed')`, no feature-file regen, no `planId` resolution, hardcoded `'ACCEPTANCE TESTED'` source (finding 5). |
| `createPlan` | 980-994 | `:10055` | parity (documented mirror) | Ingestion-engine path; re-verify after delegation changes nothing here. |
| `scanFoldersNow` | 995-1005 | `:7575` | parity | Drives the shared ingestion engine. |
| `importFromClipboard` | 1006-1041 | `:10255` | degrade-by-design | Browser supplies markdown; the no-markdown branch is an honest failure. |
| `improvePlan` | 1043-1084 | `:10002` | **diverges** | Prompt text is independently authored in bootstrap; the two prompts will drift. Clipboard-return is the legitimate degrade; the *prompt body* fork is not. |
| `reviewPlan` | 1086-1108 | `:9926` | editor-only degrade | No editor panel headless; the WS `activateKanbanTabAndSelectPlan` push is the correct substitute. |
| `createFeature`, `promoteToFeature`, `addSubtaskToFeature` | 1116-1122 | delegated | **parity** | The reference pattern for the fix. |
| `triggerAction`, `sendToTerminal` (guard) | 1128-1138 | `:8152` | **diverges** | No `_cliTriggersEnabled`/`bypassTriggerGate` gate, no `_resolveKanbanDispatchSpec`, no `_canAssignRole`, no move-first-then-dispatch ordering, no `moveCardsFailed` on a failed persist. |
| `default:` | 1140-1165 | generic dispatch | **parity** | The vehicle for the fix. |
| **Helper** `getNextKanbanColumn` | 130-143 | `_getNextColumnId` `:5798-5857` | **diverges** | Wrong at factory defaults for `CODE REVIEWED` (finding 1). |
| **Helper** `getRoleForTargetColumn` | 145-148 | `_columnToRole` `:11687` / `_resolveKanbanDispatchSpec` `:6096` | **diverges** | No custom-user column roles; falls back to `'lead'`. |
| **Helper** `moveSessionsToColumn` | 842-852 | `moveCardToColumn` + `_collectAllMovedSessionIds` `:6973` | **diverges** | Dead `sourceColumn` param; no failure reporting; no run-sheet. |
| **Helper** `isDispatchColumn` | 912 | `_resolveKanbanDispatchSpec` + `_cliTriggersEnabled` + `_canAssignRole` `:6344` | **diverges** | Different predicate entirely. |
| **Push** `pushFullState` / `getFullState` | 381-440 | `getFullStateMessages` `:1124-1227` | **diverges** | Raw columns, `cliTriggersState:false`, `routingConfig:{}` (findings 4, 6). |

Deliverable: this table, re-verified at code time, in the completion summary.

### 2. Axis 2 first — replace the hand-assembled board payload

**File:** `src/standalone/bootstrap.ts:381-440`

- Replace the body of `getFullState(scope)` with `await kanbanProvider.getFullStateMessages(workspaceRoot, scope ?? null)`.
- Replace `pushFullState`'s payload construction with the same call, broadcasting each returned entry via `server.broadcastWs(msg.type, msg, msg.surface)` — the returned entries already carry their `surface` (`KanbanProvider.ts:1191-1221`), so the existing loop shape is unchanged.
- Keep the `if (!server) return;` boot guard and the `no workspace configured yet` status branch.
- Keep the coalescing wrapper (`schedulePushFullState`, `:459-471`) exactly as is.
- Prime `_lastCards` from the returned `updateBoard` entry: `(kanbanProvider as any)._lastCards = updateBoardMsg.cards` — standalone-side, so the shipped provider is untouched.
- Standalone-only fields the provider does not know about (`dispatchAnalyzeAvailable: ptyReady`) must be merged onto the returned `updateBoard` entry rather than lost — the provider hardcodes `dispatchAnalyzeAvailable: true` (`:1211`), which is wrong for a host with no `node-pty`.
- Delete `buildBoardCards` (`bootstrap.ts:185-238`) and its `isWorkingState` helper (`:167-183`) **only if** no other caller remains; grep first — a surviving caller means a second card-shape pipeline is still live.

### 3. Axis 1 — delete the forked verb cases

**File:** `src/standalone/bootstrap.ts:895-978`, `:956-968`

- Delete the `moveSelected`/`moveAll`, `promptSelected`/`promptAll`, `completePlan`/`completeSelected` and `chatCopyPrompt` cases so they reach `default:`.
- Leave `triggerAction`/`sendToTerminal` (`:1128-1138`) routed to `handlePtyVerb` — those are the PTY boundary and are the standalone host's own concern. But add the missing gate parity inside `handlePtyVerb`'s `triggerAction` (`:1336-1425`): consult `kanbanProvider._getScopedSetting('kanban.cliTriggersEnabled', true)` (`KanbanProvider.ts:679`) unless the caller passes `bypassTriggerGate`, mirroring `:8159`.
- In `handlePtyVerb`'s `triggerAction`, replace `getNextKanbanColumn(sourceColumn)` (`:1363`) — the target column must come from the caller. Every board-initiated dispatch already supplies `targetColumn` or `role`; make the source-column fallback an explicit failure rather than a silent map lookup.
- Delete `getNextKanbanColumn` (`:130-143`) and `getRoleForTargetColumn` (`:145-148`) once the last caller is gone.
- Delete or de-parameterise `moveSessionsToColumn` (`:842-852`) depending on whether a caller survives.

### 4. Verify the render path agrees with the resolver

**File:** `src/webview/kanban.html` (read-only) vs the new push payload

- With the filtered column list now arriving, confirm `getNextColumn` (`:5169-5173`) and the `if (!nextCol) return;` gate (`:5817`) produce the same enabled/disabled button set the extension produces.
- Confirm the coded-lane compensation at `:5810-5815` (resolve to the **last visible** coded column) still works when a coded column is hidden.
- Confirm the backlog and dispatch display-mode remaps still resolve their slots (`resolveDomColumn`) when their host columns are present but neighbours are filtered out.

### 5. Parity test

**File:** `src/services/__tests__/` (new test file) — authored, not run in this plan (session directive)

> **Superseded:** "Assert that for every built-in column ID, the shared next-column function returns the same result under: default visibility, all-hidden, all-visible, and with custom columns present. Assert `isDispatchColumn` returns the same result for every built-in column."
> **Reason:** Under the replacement approach there is no shared function and no `isDispatchColumn` to test — both are deleted. A test written against them would pin an abstraction the fix removes.
> **Replaced with:** a **structural fork-detector** plus behavioural assertions:
> 1. **Fork detector (the durable gate):** assert `src/standalone/bootstrap.ts` contains no column-ordering literal — no `Record<string, string>` mapping one column ID to another, and no reference to `DEFAULT_KANBAN_COLUMNS` outside the import needed by surviving helpers. This is the same shape as the existing `push-routing:check` and `ws-surface-scoping-contract` tests, and it fails the moment someone re-adds a map. It is the gate whose absence let this drift for the whole life of the standalone host.
> 2. **Delegation assertion:** assert the `kanbanVerb` switch contains no `case 'moveSelected'` / `'moveAll'` / `'promptSelected'` / `'promptAll'` / `'completePlan'` / `'completeSelected'` / `'chatCopyPrompt'` — i.e. they reach `default:`.
> 3. **Behavioural regression assertions** against `_getNextColumnId` for the outcomes this audit found wrong, so the *outcome* is pinned even if the mechanism changes again: `CODE REVIEWED` → `null` at factory defaults; `CODE REVIEWED` → `ACCEPTANCE TESTED` with `tester: true`; `PLAN REVIEWED` → `RESEARCHER` with `researcher: true`, `LEAD CODED` without. (`KanbanProvider.test.ts:142-231` already covers these — extend rather than duplicate.)
> 4. **Payload assertion:** assert the standalone `getFullState` result's `updateColumns` entry is not identically `DEFAULT_KANBAN_COLUMNS` when a role is hidden.

## Proposed Changes

### `src/standalone/bootstrap.ts`

- **Context:** The standalone host's forked board logic — 18 hand-written verb cases (`:854-1171`), two hand-assembled state payloads (`:381-440`), and four helper functions that duplicate provider logic (`:130-148`, `:842-852`, `:912`).
- **Logic:** Swap both payloads for `kanbanProvider.getFullStateMessages`, merging the standalone-only `dispatchAnalyzeAvailable` flag and priming `_lastCards`. Delete the seven forked verb cases so they fall through to `default:`. Delete `getNextKanbanColumn`, `getRoleForTargetColumn`, and the dead `sourceColumn` parameter. Add the CLI-triggers gate to `handlePtyVerb`'s `triggerAction` and make its target-column resolution explicit.
- **Edge Cases:** `_lastCards` must be primed before any delegated `moveAll`/`promptAll` can run, or they return a plausible-but-wrong "no plans in column". `dispatchAnalyzeAvailable` must not inherit the provider's hardcoded `true` on a host without `node-pty`. Deleting `buildBoardCards` requires a grep for surviving callers. The `db` instance reached by `_getKanbanDb` must be the same cached instance bootstrap holds — verify under `db-pointer` / `kanban.dbPath` redirection.

### `src/services/KanbanProvider.ts`

- **Context:** Owns `_getNextColumnId` (`:5798-5857`), `getFullStateMessages` (`:1124-1227`), and every arm the standalone cases fork.
- **Logic:** **Read-only.** No extraction, no signature change, no new export.
  > **Superseded:** "Extract the core into a standalone-callable function; keep `_getNextColumnId` as a thin wrapper."
  > **Reason:** The extraction exists only to serve callers this plan deletes. Leaving the provider untouched removes the plan's entire contract-#2 exposure.
  > **Replaced with:** no change to this file. If profiling later shows `getFullStateMessages` needs a standalone-specific branch, that is a separate plan with its own byte-compat argument.
- **Edge Cases:** If a shim gap makes `getFullStateMessages` unusable headless, fix the **seam**, not the provider — patching the provider for the standalone host reintroduces the fork one level down.

### `src/services/__tests__/` (new)

- **Context:** No test detects standalone/extension board-logic drift; the existing `KanbanProvider.test.ts:142-231` covers `_getNextColumnId` on the extension side only.
- **Logic:** Structural fork-detector over `bootstrap.ts` + delegation assertion + payload assertion, per Implementation §5.
- **Edge Cases:** The fork-detector must not false-positive on the `DEFAULT_KANBAN_COLUMNS` import if a surviving helper legitimately needs it — scope the assertion to *mappings between column IDs*, not to the symbol's presence.

## Verification Plan

> Per session directives: SKIP compilation and SKIP automated tests. Verification is manual/inspection-based.

### Automated Tests
- Skipped per session directive. The tests in Implementation §5 are authored as the deliverable that prevents future drift; they run in CI thereafter alongside `parity:check` and `push-routing:check`.

### Manual Verification (inspection + behavior)

> **Superseded:** the previous checks 2 and 3 — "Grep bootstrap.ts for `getNextKanbanColumn` — expect zero references" and "Grep KanbanProvider.ts for the extracted function — confirm `_getNextColumnId` delegates to it".
> **Reason:** Check 2 is satisfiable while six of the seven confirmed divergences remain — it is exactly the green-metric-with-unmet-goal trap. Check 3 verifies an extraction this plan no longer performs.
> **Replaced with:** the outcome-named checks below. Each one states the *divergent behaviour* it is proving gone, not the symbol it is proving absent.

1. **Classification table re-verified.** Every row in Implementation §1 re-checked against HEAD at code time; any row whose line numbers moved is corrected in the completion summary.
2. **`CODE REVIEWED` refuses to advance at factory defaults.** With `tester` hidden (the default), a browser "move all" on Reviewed returns a failure and moves nothing — matching `KanbanProvider.test.ts:176-180`. Before this change it silently moved every card into a hidden `ACCEPTANCE TESTED`.
3. **`moveAll` works.** Clicking "move all" on a populated column in the browser (which sends `{column}` and no `sessionIds`, `kanban.html:5858`) moves the cards. Before this change it always returned `Missing column or sessionIds`.
4. **`PLAN REVIEWED` batches split by complexity.** A mixed-complexity selection moved from Planned lands in LEAD/CODER/INTERN per `_partitionByComplexityRoute`, not all in LEAD CODED.
5. **Column list is filtered.** With `tester`, `ticket_updater` and `researcher` hidden, the browser board renders the same seven columns the editor renders — not ten. With a custom column configured, it appears in both hosts at the same position.
6. **CLI-triggers state is real and consistent.** The board's trigger toggle reflects `kanban.cliTriggersEnabled` (default `true`) rather than a hardcoded `false`, and a dispatch attempt with triggers disabled is refused rather than silently performed.
7. **Completion sets status.** A plan completed from the browser has `status='completed'` in `kanban.db`, is subject to `kanban.completedLimit` pruning, and (if it belongs to a feature) triggers a feature-file regeneration. Completing a card whose `sessionId` is empty but `planId` is set succeeds.
8. **No standalone column map remains.** `bootstrap.ts` contains no column-ID→column-ID mapping and no next-column resolution of its own; `getNextKanbanColumn` and `getRoleForTargetColumn` are gone.
9. **`_lastCards` is primed.** Confirm by inspection that the standalone board push assigns `_lastCards` before any delegated verb can read it, and that the assignment lives in `bootstrap.ts`, not inside `getFullStateMessages`.
10. **Provider untouched.** `git diff` on `src/services/KanbanProvider.ts` is empty. If it is not, the change has taken on shipped-install risk that this approach was chosen to avoid.
11. **PTY dispatch still fires.** A board dispatch in the browser still reaches a PTY terminal — proving the delegated arms' `executeCommand('switchboard.triggerAgentFromKanban' | '…Batch…')` calls land on the handlers registered at `bootstrap.ts:826-837`.

## Recommendation

Complexity 7 → **Send to Lead Coder.** The audit half is routine, but the fix changes standalone behaviour on seven verbs and the entire board push in one coordinated pass, with one non-obvious ordering constraint (prime `_lastCards`, land the push before the verbs) whose omission produces a plausible-looking wrong answer rather than an error. The "delete the fork" direction is only safe if the delegation prerequisites are checked first, which is a lead-level judgement call, not a mechanical edit.

## Review Findings

**Re-reviewed 2026-08-10 (second pass) — Axis 1 has since landed; the plan is now complete.** `bootstrap.ts` no longer contains `moveSelected`/`moveAll`, `promptSelected`/`promptAll`, `chatCopyPrompt` or `completePlan`/`completeSelected` — all fall through to the `default:` arm and run the real provider arms; `getNextKanbanColumn` and `getRoleForTargetColumn` are deleted, `moveSessionsToColumn` lost its dead `sourceColumn` parameter, and `handlePtyVerb`'s `triggerAction` now applies the CLI-triggers gate via `_getScopedSetting('kanban.cliTriggersEnabled', true)` and fails honestly instead of falling back to a source-column map lookup. The plan's highest-risk prerequisite is honoured: `_lastCards` is primed from the standalone side in both `pushFullState` and `getFullState` (`(kanbanProvider as any)._lastCards = …`), never inside the shipped provider. The §5 fork-detector exists as `src/test/standalone-kanban-fork-detector.test.js`, wired as `npm run standalone-fork:check` and added to `.github/workflows/integration-tests.yml` — it passes, as do all seven ratchets, `tsc` is clean, and 69/74 contract scripts are green (the 5 reds are in `memo.js`/`terminals.js`, outside this plan). The first-pass findings below are superseded except the `ws-surface-scoping` re-anchor, which stands.

---

*First pass (superseded):* Reviewed 2026-08-10 — **Axis 2 landed, Axis 1 did not; this plan is roughly half implemented.** Axis 2 is done and done well: `pushFullState` and `getFullState` (`src/standalone/bootstrap.ts:378-461`) now delegate to `kanbanProvider.getFullStateMessages`, re-render `routingConfig`/`cliTriggersState` per declared scope as broadcast factories, override the provider's hardcoded `dispatchAnalyzeAvailable: true` with the standalone `ptyReady` gate, and are locked by a new CI-wired ratchet (`npm run standalone-parity:check`, `scripts/check-standalone-push-parity.js`) — closing findings 4 and 6. Axis 1 is untouched: `moveSelected`/`moveAll`, `promptSelected`/`promptAll`, `chatCopyPrompt` and `completePlan`/`completeSelected` are still hand-written cases (`bootstrap.ts:940-1023`), `getNextKanbanColumn` (`:130-143`, still returning `ACCEPTANCE TESTED` from `CODE REVIEWED` at factory defaults), `getRoleForTargetColumn` (`:145-148`) and `moveSessionsToColumn`'s dead `sourceColumn` parameter all survive, `moveAll` still hard-fails on the webview's no-`sessionIds` payload, and the §5 fork-detector/delegation test was never written — so findings 1, 2, 3, 5 and 7 are all still live. One fix applied by this review: `src/test/ws-surface-scoping-contract.test.js` was left **red by the Axis 2 change** (it required `bootstrap.ts` to build the four resync entries itself, which is exactly the fork Axis 2 deleted); it is re-anchored to assert the tag contract at the single producer, `KanbanProvider.getFullStateMessages`, and is green. Verification: `tsc` clean, `standalone-parity:check` / `catalog:check` / `parity:check` / `push-routing:check` / `verb-returns:check` all green — but the plan cannot be called complete, and `_lastCards` priming remains unneeded only because the delegation it exists to support has not happened.
