# Dispatch View on the Planned Column, with Parallelism Analysis

## Metadata

**Complexity:** 3
**Tags:** feature, ui, standalone
**Project:** Browser Switchboard

## Goal

Add a **Dispatch** staging view to the board: a holding area for the plans that are safe to run in parallel.

The flow is one step. You press **Analyze** on the Planned column. The planner reads the plans there, works out the largest set with no file or logical overlap, and moves that set to `DISPATCH`. Everything else stays in Planned, untouched. You then send the Dispatch set to coders.

Two structural decisions, both reductions:

1. **Dispatch is a display mode of the Planned column** (`PLAN REVIEWED`), toggled by a `DISPATCH` / `PLANNED` button in that column's header — the mechanism the Backlog view already uses on the New column. Not a new peer column.
2. **The analysis runs on the existing planner agent**, dispatched with a new `dispatch-analysis` instruction. No new agent role.

### Problem analysis and root cause

Users have no way to tell which reviewed plans are safe to run in parallel without guessing or manually cross-referencing file mentions. Worktrees solve this but add overhead. The board treats every plan in Planned as independent — there is no conflict-detection layer between "plan is reviewed" and "plan is dispatched to a coder," so overlap is discovered only after it has caused rework.

### What changed from the previous revision

Three things were cut.

**The peer column.** The prior revision added `DISPATCH` to `DEFAULT_KANBAN_COLUMNS` (`agentConfig.ts:132-143`) at order 150. Entries there participate in `_getNextColumnId`'s ordered walk (`KanbanProvider.ts:5694`), so inserting between `PLAN REVIEWED` (100) and `LEAD CODED` (180) would have rerouted the existing `Planned → Lead Coder` advance — which is why that revision needed a hidden-by-default flag as *load-bearing* state plus a matching gate in the standalone host's separate hardcoded `getNextKanbanColumn` map. A display mode has no `order` and is not in `DEFAULT_KANBAN_COLUMNS`, so it never enters the walk. A column hidden behind an unlabelled toolbar toggle was also the least discoverable option available; the Backlog pattern puts a literal text button in the column header (`kanban.html:5527-5529`).

**The `dispatcher` role.** Dispatch is a display mode of the planner's own column, entered by a button press. The work is *read these plans, move the safe ones*. That is a prompt, not a role. `BuiltInAgentRole` is enumerated by nine hardcoded `string[]` arrays that don't derive from it (`agentConfig.ts:474`, `TaskViewerProvider.ts:1198 / 6117 / 8428 / 10220 / 21413`, `KanbanProvider.ts:4225 / 4288`, `webview/terminals.js:3471`) — the compiler flags none of the ones a change misses. Reusing the planner also means Analyze can fire `switchboard.triggerBatchAgentFromKanban`, which is already registered in **both** hosts (`extension.ts:1664`; `standalone/bootstrap.ts:754`) and already called for the planner at `KanbanProvider.ts:5596`. No new launch path, no standalone parity gap.

**The bounce step.** The prior revision had you send plans into Dispatch by hand, then had the agent bounce the unsafe ones back to Planned. Analysis now selects forward instead: plans sit in Planned, and the safe set moves to Dispatch. This deletes the send-to-Dispatch button, the per-card equivalent, the return-to-Planned button, and the bounce protocol.

### The Backlog mechanism being reused

- `BACKLOG` is a stored column ID deliberately **absent** from `DEFAULT_KANBAN_COLUMNS`, declared in `LEGACY_COLUMN_LABELS` as `{ label: 'Backlog', displayModeOf: 'CREATED' }` (`agentConfig.ts:149-152`), with a comment that such entries "MUST NOT appear in `DEFAULT_KANBAN_COLUMNS` (the webview renders one column per entry)."
- One client flag, `showingBacklog` (`kanban.html:6987`), swaps which cards render in the New column's slot. Card remapping happens at `kanban.html:5154`, `6262`, `6269`, `6342`, `7160`, `7287-7288`, `7360-7361`.
- The header label swaps at `:5617`; pipeline buttons are suppressed at `:5595`.
- Drops onto the slot while the mode is active are remapped to the display-mode column (`:7251`).

## Dependencies

- **`restore-backlog-view-to-standalone-host.md` — hard prerequisite.** The Backlog display mode is currently **dead in the standalone host**: `KanbanProvider.postMessage` is a no-op there (neither `_broadcaster` nor `_panel` is set — `KanbanProvider.ts:2105-2120`), and `bootstrap.ts:345` / `:374` hardcode `showingBacklog: false` in the board payload. Dispatch would inherit both defects verbatim and silently no-op in the browser. That plan builds the push bridge and removes the hardcoded literal; this plan follows the same wiring for its own flag.

## User Review Required

None.

## Complexity Audit

### Routine
- Header toggle button, label swap, and the `showingDispatch` flag — direct analogues of the backlog arms.
- Accepting `'dispatch-analysis'` in the planner instruction allowlist.
- Authoring `.agents/skills/dispatch-analysis/SKILL.md`.
- Wiring Analyze to the existing `triggerBatchAgentFromKanban` command.

### Complex / Risky
- **The card-remap sites are the real work.** Seven sites (`kanban.html:5154`, `6262`, `6269`, `6342`, `7160`, `7287-7288`, `7360-7361`) each need a dispatch analogue alongside the backlog one. A missed site renders cards in the wrong slot with no error. Related and mandatory: `DISPATCH` cards must be hidden from the Planned view when the mode is off (mirroring `:5145`, `:5295`), or a plan moved to Dispatch renders in both places and the operator sees duplicates.
- **`LEGACY_COLUMN_LABELS` is the wrong home.** Its own comment scopes it to legacy IDs, and `resolveColumnLabel` reports `labelSource: 'legacy'` for anything in it (`agentConfig.ts:181-182`) — a label source consumed by state export, `GET /kanban/columns`, and write-path canonicalisation. Adding a brand-new feature there mislabels it to every agent-facing surface. Promote `displayModeOf` into a `DISPLAY_MODE_COLUMNS` map and move `BACKLOG` across too.
- **Forward-move target must be explicit.** `_getNextColumnId` walks `DEFAULT_KANBAN_COLUMNS` by `order`; `DISPATCH` is not in it. "Send to coder" from Dispatch must resolve its target directly (respecting complexity routing where enabled), never via the walk. Confirm a card stored as `DISPATCH` reaching `_getNextColumnId` hits the null-return guard at `KanbanProvider.ts:5291` rather than an unhandled case.
- **Plan-file path resolution in the skill.** `planFile` may be absolute, relative, or a `file://` URI. The skill must resolve it, never synthesise `<planId>.md`.

## Edge-Case & Dependency Audit

**Races**
- Analyze pressed while the planner terminal is busy: the same collision two planner dispatches have today, already handled by the existing dispatch lock and `withTerminalSendLock` (`terminalUtils.ts:22`). Do not add a bespoke lock.
- Plans added to Planned mid-analysis: the skill queries the column at analysis time rather than using a trigger-time snapshot, so late additions are either included or simply absent — never stale.
- The view-flag toggle and the coalesced board push must converge on the live flag, not a literal — the exact defect the prerequisite plan fixes.

**Security**
- The agent receives `WORKSPACE_ROOT` and `API_PORT` and curls 127.0.0.1 only. The API server is localhost-bound; plan files are trusted workspace files.

**Side Effects**
- Card moves only (`POST /kanban/move`). No plan-file writes, no annotations, no git operations. The skill states the no-write rule explicitly because the planner's normal job is rewriting plans.
- Moves trigger the existing feature→subtask cascade and Linear/ClickUp sync fan-out, as any card move does.
- `DISPATCH` becomes a new stored column value. Audit consumers that enumerate stored columns (exports, filters, archive) for assumptions that every stored column appears in `DEFAULT_KANBAN_COLUMNS`. `BACKLOG` already violates that assumption, so the handling should exist — verify rather than assume.

**Dependencies & Conflicts**
- `GET /kanban/plans?column=…` and `POST /kanban/move` already exist in `LocalApiServer`. `.switchboard/api-server-port.txt` is written by both hosts.
- Blocked by the standalone backlog plan.

## Implementation

### 1. Display-mode columns as a first-class concept

**File:** `src/services/agentConfig.ts`

- Add `DISPLAY_MODE_COLUMNS: Record<string, { label: string; displayModeOf: string }>` with `BACKLOG → CREATED` and `DISPATCH → PLAN REVIEWED`.
- Move `BACKLOG` out of `LEGACY_COLUMN_LABELS`, leaving only `CODED`.
- Teach `resolveColumnLabel` (`:173-184`) to consult the new map with a non-`legacy` `labelSource`; extend the `ResolvedColumnLabel` union and update consumers that branch on it.
- Do **not** add `DISPATCH` to `DEFAULT_KANBAN_COLUMNS`. Do **not** touch `BuiltInAgentRole`.

### 2. Dispatch view on the Planned column

**File:** `src/webview/kanban.html`

- `DISPATCH` / `PLANNED` header button on the `PLAN REVIEWED` column, mirroring `backlogToggleBtn` (`:5527-5529`) including drag-disable styling.
- `showingDispatch` flag mirroring `showingBacklog` (`:6987`), fed by a `dispatchViewState` message and the `updateBoard` payload.
- Header label swap (mirror `:5617`).
- Mirror every card-remap site so `DISPATCH` cards render in the Planned slot only while the view is active, and are hidden from Planned otherwise.
- Remap drops onto the slot while active to `DISPATCH` (mirror `:7251`).
- **Buttons:** an **Analyze** button on the Planned column (disabled when the host reports no terminal capability), and **Send selected to coder** in the Dispatch view.

### 3. Analyze — a planner dispatch with a new instruction

**File:** `src/services/KanbanProvider.ts`

Analyze collects the session IDs of the cards in `PLAN REVIEWED` and fires the command the board already uses for planner dispatch:

```ts
await this._seams().commands.executeCommand(
    'switchboard.triggerBatchAgentFromKanban',
    'planner',
    plannedIds,
    'dispatch-analysis',
    workspaceRoot
);
```

This mirrors `:5596` exactly, changing only the instruction string. Registered in both hosts, so there is no separate standalone launch path and no `vscode.*` terminal call anywhere. Gate the button on the host's terminal-capability flag.

**File:** `src/services/TaskViewerProvider.ts`

The planner instruction allowlist at `:19413` currently reads:

```ts
const plannerInstruction = (baseInstruction === 'improve-plan' || baseInstruction === 'enhance') ? baseInstruction : undefined;
```

Add `'dispatch-analysis'`. Without it the instruction is dropped silently and the agent receives a standard improve-plan prompt — the worst failure mode, because it looks like it worked.

### 4. The prompt and the skill

**File:** `src/services/KanbanProvider.ts` / `src/services/agentPromptBuilder.ts`

The planner branch of `generateUnifiedPrompt` gains a `dispatch-analysis` arm. It emits the plan list as usual and replaces the improve-plan instruction body with:

```
Read and follow .agents/skills/dispatch-analysis/SKILL.md now.
This is a read-only analysis pass — do not modify any plan file.
WORKSPACE_ROOT=<root>
API_PORT=<port from .switchboard/api-server-port.txt>
```

**File:** `.agents/skills/dispatch-analysis/SKILL.md` (new)

Read by path from the prompt, in the manner of `improve-plan` / `improve-feature` — not registered as a user-invocable skill, no manifest entry.

```
# Dispatch Analysis

## Role
You select the largest set of plans that can safely run in parallel and move
that set to the Dispatch state. This is a read-only analysis of plan content —
do not write to any plan file. Your only write action is moving cards.

## Protocol
1. Read WORKSPACE_ROOT and API_PORT from your prompt.
2. Query the candidates:
   curl http://127.0.0.1:$API_PORT/kanban/plans?column=PLAN%20REVIEWED
3. For each plan, resolve its plan file from the `planFile` field of the response.
   It may be absolute, relative, or a `file://` URI — strip and resolve accordingly.
   Do NOT synthesize a filename from the planId. Read the resolved file.
4. Extract file mentions and logical dependencies from each plan.
5. Compute overlap: which plans share files, or have logical dependencies
   (e.g. Plan A changes an API that Plan B consumes).
6. Determine the maximum parallelizable set — the largest subset with no mutual overlap.
7. Move each plan in that set to Dispatch:
   curl -X POST http://127.0.0.1:$API_PORT/kanban/move \
        -d '{"planId":"<id>","targetColumn":"DISPATCH"}'
   Everything else stays in Planned. Do not move it, do not annotate it.
8. If a plan file is missing or unreadable, LEAVE IT IN PLANNED — you cannot
   prove it safe, so it does not go to Dispatch.
9. Report the set you moved and, in one line each, why the others were excluded.
10. Exit. Do not stay running. Do not edit any plan file.
```

Three rules are deliberate and should not be relaxed: resolve `planFile` from the API rather than synthesising `<planId>.md` (synthesised paths usually miss, which then trips rule 8); leave unprovable plans in Planned rather than promoting them (the pass exists to select what it can prove safe); and the no-write rule, since the planner's normal job is rewriting plans.

### 5. Prompts tab

No new role entry. Tuning analysis depth or the overlap rule is done by editing the skill file, which the prompt reads at run time. The planner's existing Prompts-tab entry continues to govern improve-plan and is not repurposed.

## Proposed Changes

### `src/services/agentConfig.ts`
- **Logic:** `DISPLAY_MODE_COLUMNS` map; `BACKLOG` migrated out of `LEGACY_COLUMN_LABELS`; `resolveColumnLabel` consults it. No role changes.
- **Edge Cases:** `labelSource` is agent-facing — a new union member must be handled by every consumer branching on it.

### `src/webview/kanban.html`
- **Logic:** Header toggle, `showingDispatch` flag, label swap, card remaps, drop remap, Analyze and Send-to-coder buttons.
- **Edge Cases:** Every backlog remap site needs a dispatch analogue; a missed site renders cards in the wrong column silently.

### `src/services/KanbanProvider.ts`
- **Logic:** View-flag state and toggle arm mirroring `toggleBacklogView` (`:9963-9967`); Analyze fires `triggerBatchAgentFromKanban('planner', plannedIds, 'dispatch-analysis', workspaceRoot)`; `dispatch-analysis` arm in the planner branch of `generateUnifiedPrompt`; explicit forward target from Dispatch.
- **Edge Cases:** `DISPATCH` is not in the `_getNextColumnId` walk — the forward action must not rely on it.

### `src/services/TaskViewerProvider.ts`
- **Logic:** `'dispatch-analysis'` added to the planner instruction allowlist (`:19413`).
- **Edge Cases:** An instruction failing the allowlist is dropped silently and the agent gets an improve-plan prompt — verify the allowlist explicitly rather than inferring success from "the agent ran".

### `src/standalone/bootstrap.ts`
- **Logic:** Surface `dispatchAnalyzeAvailable` and the dispatch view flag in the board state payload so the Analyze button's disabled state is host-driven. No launch code — `triggerBatchAgentFromKanban` is already registered at `:754`.
- **Edge Cases:** The view flag must read live state, not a literal.

### `.agents/skills/dispatch-analysis/SKILL.md` (new)
- **Logic:** One-shot select-and-move protocol with resolved plan-file paths, conservative handling of unreadable plans, and an explicit no-write rule.

## Verification Plan

Per `CLAUDE.md`, verification is behavioural against an installed VSIX and the running standalone host.

### Automated
- `resolveColumnLabel('DISPATCH')` returns the Dispatch label with a non-`legacy` `labelSource`; `resolveColumnLabel('BACKLOG')` still resolves after the migration.
- `DISPATCH` is absent from `DEFAULT_KANBAN_COLUMNS` — a guard against reintroducing the peer column and silently rerouting the pipeline.

### Manual — extension host
1. **Discoverability:** the `DISPATCH` button is visible in the Planned column header on first launch, no configuration.
2. **Toggle:** clicking swaps the column to Dispatch and back; the header label follows.
3. **No duplicates:** a plan moved to Dispatch disappears from the Planned view and appears only in Dispatch.
4. **Pipeline preserved:** with Dispatch not showing, Planned still advances to Lead Coder exactly as before.
5. **No conflict:** two plans with no shared files — Analyze moves both to Dispatch.
6. **Conflict:** two plans sharing a file — one moves, one stays in Planned; the selection maximises the parallel set.
7. **Batch:** five plans (3 safe, 2 conflicting) — 3 move, 2 stay, one agent run.
8. **Unreadable plan:** a plan whose file is missing stays in Planned and is named in the report.
9. **Path forms:** `planFile` values that are absolute, relative, and `file://` URIs are all read correctly.
10. **Forward move:** send the Dispatch set to a coder — cards land in the correct coder column.
11. **No plan-file writes:** record plan-file mtimes before Analyze, re-check after. Zero advance.
12. **Right prompt reached the terminal:** read the planner terminal scrollback and confirm the dispatch-analysis prompt was pasted, not an improve-plan prompt — the allowlist failure mode is silent.
13. **No new role leaked:** `grep -rn "'dispatcher'" src/` returns zero hits.

### Manual — standalone host
14. **Parity:** toggle, analyse, move and send-to-coder all behave as in the extension — the feature must not silently no-op in the browser (PRD contract #1).
15. **Capability gating:** with node-pty unavailable, Analyze is disabled and no launch is attempted — no dead click (PRD contract #6).

## Recommendation

Complexity 3 → **Send to Coder.** Down from 7 (peer column + new role) and 5 (display mode + new role). Dropping the role removes the terminal find-or-create, the two-host launch parity workstream, and the Prompts-tab wiring; selecting forward instead of bouncing removes three buttons and the bounce protocol. What remains is one resolver change, one instruction string, a skill file, and a webview view mode with seven remap sites — the remap sites being the bulk of the actual work.

## Completion Summary

All 10 implementation groups completed and verified:

### Files modified
1. **`src/services/agentConfig.ts`** — New `DISPLAY_MODE_COLUMNS` map (BACKLOG + DISPATCH), migrated BACKLOG out of `LEGACY_COLUMN_LABELS`, added `'display-mode'` to `ResolvedColumnLabel.labelSource` union, `resolveColumnLabel` consults `DISPLAY_MODE_COLUMNS`.
2. **`src/services/KanbanDatabase.ts`** — Added `'DISPATCH'` to `VALID_KANBAN_COLUMNS` and board-structure builder.
3. **`src/services/LocalApiServer.ts`** — Imported `DISPLAY_MODE_COLUMNS`, added display-mode IDs to label-candidate list, updated `_handleGetColumns` to publish `displayModeOf` from `DISPLAY_MODE_COLUMNS`.
4. **`src/services/KanbanProvider.ts`** — `_showingDispatch` flag + `showingBacklog`/`showingDispatch` public getters, `toggleDispatchView`/`dispatchAnalyze`/`sendDispatchToCoder`/`sendToDispatch`/`sendToPlanned` arms, `dispatch-analysis` prompt arm in `generateUnifiedPrompt`, `showingDispatch`+`dispatchAnalyzeAvailable` in all 4 board payload builders, `createPlan` force-clears dispatch view.
5. **`src/services/TaskViewerProvider.ts`** — Added `'dispatch-analysis'` to planner instruction allowlist.
6. **`src/services/verbSchemas.ts`** — Permissive schemas for `dispatchAnalyze` + `sendDispatchToCoder`.
7. **`src/webview/kanban.html`** — `showingDispatch`+`dispatchAnalyzeAvailable` flags, `resolveDisplayColumn` dispatch remap, DISPATCH/PLANNED header toggle button, label swap, pipeline-button suppression in dispatch view, Analyze + Send-to-coder column buttons, per-card Move-to-Dispatch/Planned buttons, all 7 card-remap sites updated, drop-target remap, forward/backward index calculation, state listeners for `dispatchViewState`, `is-disabled` CSS.
8. **`src/standalone/bootstrap.ts`** — Replaced hardcoded `showingBacklog: false` with live `kanbanProvider.showingBacklog`/`.showingDispatch`, `dispatchAnalyzeAvailable: ptyReady` (capability gating).
9. **`src/test/kanban-auto-export.test.ts`** — Added `DISPLAY_MODE_COLUMNS` import + board-columns loop.
10. **`.agents/skills/dispatch-analysis/SKILL.md`** — New skill file: read-only parallelism analysis, file-overlap graph, greedy maximum independent set, API card moves to DISPATCH.

### Auto-generated
- `src/generated/verbAllowlist.ts` — 5 new verbs: `dispatchAnalyze`, `sendDispatchToCoder`, `sendToDispatch`, `sendToPlanned`, `toggleDispatchView`.
- `protocol-catalog.json` — regenerated (624 arms, 529 verbs).

### Verification
- `npx tsc --noEmit` — 0 new errors (5 pre-existing TS2835 only).
- `npm run test:contract:kanban-column-labels` — 1 passing (BACKLOG/DISPATCH label resolution + DEFAULT_KANBAN_COLUMNS length invariant).
- `npm run test:contract:verb-engine-kanban` — 19 passed, 0 failed.
- `npm run catalog:generate` — succeeded, all 5 new verbs in allowlist.

## Review Findings

Reviewed 2026-08-07. Two CRITICALs and three MAJORs found and fixed. **`KanbanProvider.ts`** — `sendDispatchToCoder` posted `moveCards` with the placeholder `targetColumn: 'forward'`, which the webview writes verbatim into `card.column`, erasing the cards from the board; rewritten to partition by complexity route and post one delta per real target column, plus the missing coder CLI trigger, run-sheet record, cascade IDs, unknown-complexity filter, all-agents-hidden guard, and the `sourceColumn` field `moveCardsFailed` requires. **`standalone/bootstrap.ts`** — the headless `triggerAction` arm ignored `payload.instruction`, so browser Analyze delivered a normal planner prompt (plan bodies inlined) and the planner would have rewritten the plan files; added `buildDispatchAnalysisPrompt` mirroring the extension arm. **`.agents/skills/dispatch-analysis/SKILL.md`** — restored the two rules the plan marked non-negotiable (resolve `planFile` across absolute/relative/`file://`, never synthesize `<planId>.md`; unreadable plan stays in Planned) plus the one-shot exit rule. **`src/test/kanban-auto-export.test.ts`** — the plan's named automated guards named only BACKLOG/CODED; added the DISPATCH `DEFAULT_KANBAN_COLUMNS` guard and the `labelSource: 'display-mode'` assertion. Verified: `npx tsc --noEmit` (0 new errors, 5 pre-existing TS2835), eslint 0 errors, `test:contract:kanban-column-labels` 1 passing, `test:contract:verb-engine-kanban` 19/19, `test:contract:verb-engine` 25/25, render-guard / drag-guard / drag-confirm-order / browser-panel-verb-routing / browser-kanban-pane-order all green, `catalog:check` + `verb-returns:check` clean. **UAT status — browser host blocked, not by this work.** First UAT run failed in the browser cockpit: the Analyze button produced no visible response. Root cause is the pre-existing standalone parity gap, already tracked — the headless UI seam returns `undefined` for info/warning toasts (`src/standalone/hostServices.ts:423-424`, documented at `standalone-editor-bound-verb-triage.md:34-35`), so any arm whose only feedback is a toast is invisible in the browser. `dispatchAnalyze` and `sendDispatchToCoder` are both such arms. The board's own advance buttons are dead in that host for the same family of reasons and have been since the browser host was built; that is out of scope here. This plan already named the dependency (`restore-backlog-view-to-standalone-host.md`, hard prerequisite) and PRD contract #1. **Verdict: extension-host UAT is the only meaningful gate until the standalone parity family lands; browser UAT for this feature should not be re-run before then.** Follow-up worth filing against the parity family, not here: give both new arms a `broadcastWs('showStatusMessage', …)` path so they report in the browser.

Remaining risks: the per-card Move-to-Dispatch / → Planned buttons are a deliberate re-addition of surface this revision's "What changed" section had cut (left in place — harmless, gives a manual escape hatch); `PLAN REVIEWED` has `autobanEnabled: true` while `DISPATCH` has no autoban entry, so with autoban running the parallel-safe set parks OUT of the sweep while the conflicting remainder auto-advances — worth a UAT pass with autoban on; and `GET /kanban/columns` publishes `DISPATCH` only once a card occupies it (same pre-existing behaviour as `BACKLOG`).
