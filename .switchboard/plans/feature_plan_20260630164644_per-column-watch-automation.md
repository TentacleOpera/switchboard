# Per-Column Watch Mode for Kanban Automation

## Goal

Add a per-column **trigger mode** to Kanban automation so each automated column can be set to either:

- **Drain** (current behavior, default) — process the plans currently sitting in the column, then auto-stop the whole engine once no enabled column has eligible cards left. Safe for finite batch runs.
- **Watch** (new) — treat the column as a *standing trigger*: never auto-stop on empty, keep the engine alive, and dispatch a plan to its agent **the instant it arrives** in the column.

The setting is **per column** (the user explicitly wants "watch CREATED, drain the rest" to be expressible), and the UI must clearly explain the cost/risk of leaving an engine running indefinitely.

### Problem Analysis & Root Cause

Today the automation engine has exactly one termination policy and it is **global and drain-only**.

The live engine driven by the Kanban **AUTOMATION** tab is the *autoban* engine in `src/services/TaskViewerProvider.ts` (`_startAutobanEngine` → per-column `setInterval` timers in `_autobanTimers`, each ticking `_autobanTickColumn` at `rules[column].intervalMinutes`). Plan dispatch and the stop decision both funnel through one method:

- **`_stopAutobanIfNoValidTicketsRemain(workspaceRoot)`** (TaskViewerProvider.ts:6893) → `_autobanHasEligibleCardsInEnabledColumns` (6868). If **no enabled column** has an eligible card, it calls `_stopAutobanForNoValidTickets` (6799) → `_stopAutobanWithMessage` → `_stopAutobanEngine`, which clears every timer and flips `enabled=false`.

This stop check is invoked from **every** quiet path:
- the 60-second empty-column sweep timer (`_autobanEmptyColumnSweepTimer`, set up at 8447 and 7572),
- after a tick when the column is empty (8497) or has no eligible cards (8503),
- after each successful dispatch (8556), and the PLAN REVIEWED routing paths (8569, 8605).

So as soon as the board drains, the engine kills itself. There is **no way to keep it armed** for plans that arrive later. That is exactly the user's two blocked use cases:

1. **CREATED column** — the user wants "any plan that lands in CREATED instantly goes to a Planner agent." With drain-only, the engine stops the moment CREATED empties, so the next plan dropped in does nothing.
2. **Remote-control hand-off** — the user finishes planning a card, then later flips its status to hand it to the coder. They want the coder to fire *on arrival*. Drain-only has already stopped by then.

The protective rationale for drain-only is real for the *middle* of the pipeline: once a batch finishes you want the engine to stop cleanly rather than stay armed and fire an unattended agent run at every plan that later passes through. (The idle loop itself costs nothing — a tick is just a SQL query against `kanban.db`; Switchboard makes no LLM calls. Token cost is incurred only *downstream*, when a dispatch types a prompt into a terminal and the CLI agent there runs. So the concern is automatic, unattended agent runs, not idle spend.) But that protection is wrong for entry columns and human-paced hand-off columns. Hence: make the policy **per column**, not global.

There is also a latent asymmetry worth noting (not the thing we're changing, but context): the *other* continuous engine, `PipelineOrchestrator._advance()` (src/services/PipelineOrchestrator.ts:187-211), already **idles** when there are zero active sheets but **auto-stops** when sheets exist yet are all `done`. That orchestrator is wired to `pipeline*` webview messages (TaskViewerProvider.ts:9991-10009) that **no current webview sends** (`grep` for `pipelineStart` in `src/webview` returns nothing) — it is vestigial relative to the Kanban AUTOMATION tab and is **out of scope** here. We touch only the autoban engine. (Implementer note: do not "fix" the orchestrator's auto-stop as part of this; it is not the engine the AUTOMATION tab drives.)

### Background Context

- **Config home.** Per-column automation config already lives in `AutobanRuleState` (`src/services/autobanState.ts:1-4`: `{ enabled, intervalMinutes }`) inside `AutobanConfigState.rules: Record<string, AutobanRuleState>`. Adding `triggerMode` there is the natural per-column home and works for both automation modes:
  - **multi-column** mode iterates every enabled rule;
  - **single-column** mode automates one column (`singleColumnConfig.sourceColumn`) and rebuilds `rules` as `{ [sourceColumn]: { enabled, intervalMinutes } }` at TaskViewerProvider.ts:7266 — that rebuild must be extended to carry `triggerMode`.
- **Arrival paths that must fire a watch column.** A card "enters" a column via several writers, all of which ultimately funnel through `KanbanDatabase`:
  - `updateColumnByPlanFile` (KanbanDatabase.ts:1462) and `movePlanByPlanFile` (1594) — manual drag, forward-move buttons (`handleKanbanForwardMove` → `_applyManualKanbanColumnChange`), and remote-control status changes;
  - `insertFileDerivedPlan` (1339) — new plan files discovered by `GlobalPlanWatcherService`, which always land in CREATED.
  `KanbanDatabase` currently exposes **no change event** (grep: no `EventEmitter`/`onDidChange`). The robust, single-chokepoint way to make watch "instant" across *all* arrival paths is to add one column-change event on `KanbanDatabase` and wire it to the engine.
- **Published extension, ~4,000 installs.** Per workspace `CLAUDE.md`, shipped state must migrate safely. `triggerMode` is an **additive optional field** that defaults to `'drain'`, so every existing install and every legacy rule with no `triggerMode` keeps today's exact behavior. No `*.migrated.bak`, no destructive change. Unknown/legacy keys in `rules` are already preserved by `normalizeAutobanConfigState`'s merge.
- **DB access pattern (verified).** `KanbanDatabase.forWorkspace` is a **singleton factory** (`_instances` Map, KanbanDatabase.ts:663). The provider already retrieves the same singleton DB instance directly via `KanbanDatabase.forWorkspace(root)` (TaskViewerProvider.ts:592, 848). Because writers and the engine resolve the same singleton per workspace root, an `onColumnChanged` event fired inside the DB write methods reaches a subscription the provider holds on that same instance. This is why the event wiring belongs **inside the provider** (subscribe on engine start, dispose on engine stop), not in `extension.ts` — see §3b.

## Metadata

- **Tags:** `frontend, backend, ui, feature`
- **Complexity:** 6/10
- **Files touched:** `src/services/autobanState.ts`, `src/services/TaskViewerProvider.ts`, `src/services/KanbanDatabase.ts`, `src/webview/kanban.html`. (`src/extension.ts` is **not** touched — event wiring lives in the provider, see §3b. `GlobalPlanWatcherService.ts` is not touched; the CREATED-insert arrival is covered by the `insertFileDerivedPlan` emit.)
- **Risk:** Medium. The core engine change (one guard in `_stopAutobanIfNoValidTicketsRemain`) is small and high-leverage, but it inverts a long-standing "always stops" invariant — the risk is an engine that *never* stops when the user didn't intend it to, which is why the UI must make the watch semantics unmistakable and the running-state must be visible.

## User Review Required

Yes — before implementation. Review points for the user:

1. **Watch semantics confirmation.** Confirm the intended mental model: a single Watch column anywhere in the enabled set keeps the **entire** engine alive (drain columns keep ticking as harmless no-ops). This is the intended trade-off, not a bug — but it is a behavior change worth an explicit nod.
2. **Risk-callout copy.** The amber callout text in §5c is the user's stated risk communication (no confirm gate, per CLAUDE.md). User should sign off on the wording before it ships.
3. **Event-wiring location decision.** The plan wires `onColumnChanged` **inside the provider** (subscribe on engine start, dispose on engine stop) rather than in `extension.ts`. This is a deliberate deviation from the original draft and is strictly safer (auto-scoped, no leak). Confirm acceptable.
4. **`insertFileDerivedPlan` emit gating.** Confirm the approach of pre-checking `hasPlanByPlanFile` (or post-write `changes()`) so the CREATED arrival event fires only on a genuine new row, not on ON CONFLICT re-imports of plans already past CREATED.

## Complexity Audit

### Routine

- Extending `AutobanRuleState` with an additive optional `triggerMode` field and defaulting it in `normalizeAutobanConfigState`'s rule `.map` (autobanState.ts:209-216). No migration, no destructive change.
- The single termination guard in `_stopAutobanIfNoValidTicketsRemain` (TaskViewerProvider.ts:6893) — one early return, covers all stop sites because they all route through this method (verified: sweep timer at 8447 and 7572, post-tick, post-dispatch).
- Carrying `triggerMode` through the single-column synthetic-rules rebuild (TaskViewerProvider.ts:7265-7267) and the multi-column `updateAutobanConfigFromKanban` spread (7304-7308, preserved automatically once normalization keeps the field).
- Per-column `Drain`/`Watch` segmented toggle in the two webview rule-rendering sections (single-column ~7892-7926, multi-column ~8340-8388) — reuses existing `emitAutobanState()` / `setAutomationMode` message paths.
- Risk callout (amber `border-left` banner, same visual family as `poolBannerMc` at kanban.html:8391-8394) and running-state tooltip string.

### Complex / Risky

- **Fire-on-enter event plumbing** (the genuinely new surface): adding `vscode.EventEmitter` `onColumnChanged` to `KanbanDatabase`, gating the `insertFileDerivedPlan` emit to true INSERTs only (ON CONFLICT does not change `kanban_column`, so a naive emit would falsely nudge CREATED for re-imported plans already past CREATED), and subscribing/disposing the listener inside the provider's engine lifecycle. This is the part with real correctness risk.
- **Inverting the "always stops" invariant.** A watch column makes the engine a standing watcher; the risk is an engine that never stops when the user didn't intend it to. Mitigated by the guard being scoped to enabled watch columns only and by the UI risk callout + running-state affordance.
- **Burst arrival coalescing.** A ~750ms per-column debounce in the arrival handler reduces redundant tick enqueues (correctness is already guaranteed by `_activeDispatchSessions` dedupe inside `_autobanTickColumn`; the debounce is a load optimization, not a correctness mechanism).

## Edge-Case & Dependency Audit

### Race Conditions

- **Burst arrival.** Many plans imported into a watch CREATED at once: the ~750ms per-column debounce coalesces the nudges into one tick; `_enqueueAutobanTick` serializes on `_autobanTickQueue` (TaskViewerProvider.ts:8409); `_activeDispatchSessions` (checked in `_autobanTickColumn` via `_getEligibleAutobanCards`, 6812-6816) prevents duplicate dispatch of an already-dispatched card. Net: one coalesced tick, up to `batchSize` dispatches, no duplicates.
- **Arrival during an in-flight tick.** The arrival nudge enqueues behind the running tick on `_autobanTickQueue`; it does not preempt. The next tick sees the newly-arrived card.
- **Engine stop racing an arrival.** If a watch column is active, the stop guard returns early so no stop fires. If the last watch column is removed/disabled while a tick is in flight, the next sweep (≤60s) or next tick's stop check fires normally — no manual cleanup.

### Security

- No new untrusted input surfaces. `triggerMode` is normalized to exactly `'drain'` or `'watch'` (anything else → `'drain'`); column names in the event payload are already validated by `VALID_KANBAN_COLUMNS` / `SAFE_COLUMN_NAME_RE` at the DB write methods (1463, 1595).
- The event fires inside try/catch and never blocks or fails the DB write.

### Side Effects

- **No-op moves still emit.** `updateColumnByPlanFile` / `movePlanByPlanFile` fire `onColumnChanged` on every successful write even when the column value is unchanged. Harmless: the arrival handler checks `isWatchColumn` and the tick no-ops on an already-dispatched/absent card. Stated for honesty, not a defect.
- **Drain columns keep ticking while a watch column is active.** Because the guard suppresses the global stop whenever any enabled watch column exists, drain columns' periodic timers keep firing as harmless empty-tick no-ops. This is the intended trade-off; the UI risk copy must state it.
- **Idle cost is zero.** A tick is a SQL query; Switchboard makes no LLM calls. Cost is per arrival (one agent run per dispatched card).

### Dependencies & Conflicts

| Edge case / dependency | Handling |
|---|---|
| Existing installs with no `triggerMode` in any rule | `normalizeAutobanConfigState` defaults each rule's `triggerMode` to `'drain'` → identical to today. No migration. |
| Session cap reached while watching | **Do NOT suppress** `_stopAutobanForExhaustion` (6795). Hitting the global session cap is a real budget stop and must still halt the engine even with a watch column. Watch only suppresses the *no-valid-tickets* stop. |
| No eligible terminals in multi-column (`_allEnabledAutobanRolesExhausted`) | **Do NOT suppress.** If there are literally no terminals, watching is pointless; let the exhaustion stop fire. Document that watch resumes only after the engine is restarted with terminals available. |
| Watch column empties, drain columns also empty (multi-column) | Guard suppresses the global stop whenever *any* enabled watch column exists → drain columns keep ticking (harmless no-ops). Intended trade-off; UI risk copy states it. |
| Removing/disabling the last watch column while the board is empty | Guard no longer true → the next sweep (≤60 s) or next tick auto-stops normally. No manual cleanup needed. |
| Arrival into a column whose rule is `enabled:false` | `notifyAutobanWatchArrival` checks the rule is enabled AND `triggerMode==='watch'` (scoped to `sourceColumn` in single-column mode via `_getEnabledAutobanSourceColumns`) before enqueuing. Disabled or drain columns get no instant tick. |
| `insertFileDerivedPlan` ON CONFLICT re-import of a plan already past CREATED | **Emit only on a true INSERT.** Pre-check `hasPlanByPlanFile` (KanbanDatabase.ts:1419) before the write, or inspect `changes()` after; emit `onColumnChanged` with `'CREATED'` only when the row is genuinely new. A naive emit on every call would falsely nudge a CREATED watch column for re-imported plans sitting elsewhere. |
| Pause/resume | Unchanged: timers rebuild on resume; the sweep timer simply won't stop the engine while a watch column is active. Arrival nudges no-op while `paused` (the tick early-returns on `!enabled`/paused). |
| Mode switch single ↔ multi-column | `triggerMode` persists per rule in `rules`; preserved across switches. Single-column UI shows the toggle for its one `sourceColumn`; multi-column shows it per row. |
| `confirm()` / dialogs | None. Per workspace `CLAUDE.md`, the toggle applies immediately; the risk is communicated via an always-visible callout, not a confirm gate. |
| `dist/` | Not audited; `src/` is source of truth. |

## Dependencies

- None. This is a self-contained feature change to the autoban engine. No prerequisite sessions or plans.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the fire-on-enter event plumbing is the genuinely new surface — a naive `insertFileDerivedPlan` emit would falsely nudge CREATED for ON CONFLICT re-imports of plans already past CREATED, so the emit must be gated to true INSERTs only; (2) inverting the always-stops invariant risks an engine that never stops when the user didn't intend it, mitigated by scoping the guard to enabled watch columns and a prominent UI risk callout; (3) the event wiring must live inside the provider's engine lifecycle (subscribe on start, dispose on stop), not in `extension.ts`, because `KanbanDatabase.forWorkspace` is a lazily-created singleton factory with no single construction site. Mitigations: pre-check `hasPlanByPlanFile` before emitting on insert; subscribe/dispose the `onColumnChanged` listener in `_startAutobanEngine`/`_stopAutobanEngine`; rely on `_activeDispatchSessions` (not the tick queue) for dispatch dedupe correctness, with the 750ms debounce as a load optimization only.

## Proposed Changes

### 1. `src/services/autobanState.ts` — add the per-column field

- Extend the type:
  ```ts
  export type AutobanTriggerMode = 'drain' | 'watch';
  export type AutobanRuleState = {
      enabled: boolean;
      intervalMinutes: number;
      triggerMode?: AutobanTriggerMode; // default 'drain'
  };
  ```
- In `normalizeAutobanConfigState`, when normalizing each rule (the `.map` at 209-216), set
  `triggerMode: rule?.triggerMode === 'watch' ? 'watch' : 'drain'`. This guarantees a concrete value and preserves behavior for every legacy rule.
- Add a tiny helper for the engine/UI:
  ```ts
  export function isWatchColumn(rule?: AutobanRuleState | null): boolean {
      return rule?.triggerMode === 'watch' && rule?.enabled === true;
  }
  ```
- `SingleColumnAutobanConfig` already maps onto `rules[sourceColumn]`; no separate field needed there — the single-column UI writes `triggerMode` into that one rule (see §4 and §5).

### 2. `src/services/TaskViewerProvider.ts` — suppress the no-tickets stop when a watch column is active

- Add a private helper that respects mode scoping (reuse `_getEnabledAutobanSourceColumns`, 6803):
  ```ts
  private _hasActiveWatchColumn(): boolean {
      return this._getEnabledAutobanSourceColumns()
          .some(col => isWatchColumn(this._autobanState.rules[col]));
  }
  ```
- In **`_stopAutobanIfNoValidTicketsRemain`** (6893), before computing eligibility / stopping:
  ```ts
  if (this._hasActiveWatchColumn()) {
      return false; // standing watcher — never auto-stop on empty
  }
  ```
  This single guard covers all stop sites (sweep timer at 8447 and 7572, per-tick empty/no-eligible, post-dispatch) because they all route through this method. **Do not** touch `_stopAutobanForExhaustion` (6795, session cap) or `_allEnabledAutobanRolesExhausted` (no terminals) — those remain hard stops (see edge-case table).

### 3. Fire-on-enter: one column-change event from `KanbanDatabase` → provider

**3a. `src/services/KanbanDatabase.ts`** — add a best-effort event:
- A `vscode.EventEmitter<{ workspaceId: string; planFile: string; column: string }>` exposed as `onColumnChanged` (dispose in the DB's existing dispose path).
- Fire it (inside try/catch, never blocking/failing the write) at the end of the successful branches of:
  - `updateColumnByPlanFile` (1462) — after the verify block,
  - `movePlanByPlanFile` (1594) — after `_persistedUpdate` returns true,
  - `insertFileDerivedPlan` (1339) — **only on a true INSERT, not ON CONFLICT UPDATE.** The SQL (1363-1378) is `INSERT ... ON CONFLICT(plan_file, workspace_id) DO UPDATE` and the DO UPDATE clause does **not** change `kanban_column`, so emitting unconditionally would falsely nudge a CREATED watch column for re-imported plans that are already past CREATED. Gate the emit: pre-check `hasPlanByPlanFile(record.planFile, record.workspaceId)` (1419) before the write, or inspect the sql.js `changes()` count / a pre/post row existence check, and emit with column `'CREATED'` only when the row is genuinely new. This is the single chokepoint that catches manual moves, forward-move buttons, remote-control status changes, and watcher inserts — but only true arrivals.
- Note: no-op moves (same column) still emit; harmless (tick no-ops on already-dispatched/absent cards). Stated for honesty.

**3b. `src/services/TaskViewerProvider.ts`** — subscribe inside the provider's engine lifecycle (NOT `extension.ts`):
- `KanbanDatabase.forWorkspace` is a lazily-created singleton factory (`_instances` Map, KanbanDatabase.ts:663) with no single construction site, so wiring in `extension.ts` would either miss not-yet-created instances or leak subscriptions across engine restarts. The provider already retrieves the same singleton DB via `KanbanDatabase.forWorkspace(root)` (592, 848), so the clean, leak-free wiring is:
  - In `_startAutobanEngine` (8424), after the timers are set up, resolve the workspace DB and subscribe: `this._autobanWatchDisp = db.onColumnChanged(e => this._notifyAutobanWatchArrival(e.column, e.workspaceId))` (resolve the workspace root from `e.workspaceId`).
  - In `_stopAutobanEngine` (8461), dispose `this._autobanWatchDisp` alongside clearing timers.
- This auto-scopes the listener to engine lifetime: zero event noise when the engine is off, zero cross-restart leaks, and the handler can be private.

**3c. `src/services/TaskViewerProvider.ts`** — new **private** method:
  ```ts
  private _notifyAutobanWatchArrival(column: string, workspaceRoot: string): void {
      if (!this._autobanState.enabled || this._autobanState.paused) { return; }
      if (!this._getEnabledAutobanSourceColumns().includes(column)) { return; }
      if (!isWatchColumn(this._autobanState.rules[column])) { return; }
      // ~750ms per-column debounce to coalesce bursts (load optimization;
      // correctness is already guaranteed by _activeDispatchSessions dedupe
      // inside _autobanTickColumn — see Edge-Case/Race Conditions).
      this._enqueueAutobanTick(column, this._autobanState.batchSize);
  }
  ```
  Reusing `_enqueueAutobanTick` (8409) means the arrival tick is **serialized** on `_autobanTickQueue` exactly like a timer tick. The actual duplicate-dispatch prevention comes from `_activeDispatchSessions` (checked in `_autobanTickColumn` via `_getEligibleAutobanCards`, 6812-6816), so an arrival for an already-dispatched card is a cheap no-op. The per-column interval timer remains as a periodic safety poll behind the instant nudge.

### 4. `src/services/TaskViewerProvider.ts` — carry `triggerMode` through config writes

- **Single-column** `setAutomationMode` handler rebuilds `rules` at ~7265-7267 as `{ [sourceColumn]: { enabled: true, intervalMinutes } }`. Extend the message payload and this rebuild to include `triggerMode` from the webview, e.g. `{ enabled: true, intervalMinutes, triggerMode }`.
- **Multi-column** updates flow through `updateAutobanConfigFromKanban` (7304), which spreads incoming `rules` into state and re-normalizes — so per-row `triggerMode` from the webview is preserved automatically once §1 normalization keeps it.

### 5. `src/webview/kanban.html` — per-column toggle + clear risk explanation

**5a. Single-column rule row** (the column-select row at ~7892-7926, with the interval input below): add a small segmented **TRIGGER** control (`Drain` / `Watch`) next to the interval input. On change, set the `singleColumnConfig`-adjacent state and post the existing `setAutomationMode` message (7914-7924) with the new `triggerMode` field added to the payload.

**5b. Multi-column rules section** (the per-column rule row at ~8340-8388, which posts via `emitAutobanState()` at 8349/8376): add the same `Drain`/`Watch` toggle to each column's rule row, writing `state.rules[column].triggerMode` and calling `emitAutobanState()`.

**5c. Risk callout (required).** When **any** column in the visible config is set to `Watch`, render a prominent callout (same visual family as the existing `poolBannerMc` box at kanban.html:8391-8394 — an amber `border-left` banner) stating, in plain language:

> ⚠️ **Watch mode runs agents automatically.** Columns set to **Watch** never stop on their own. Every plan that lands in a watch column is dispatched to its agent **immediately and unattended** — no batch delay, no review step. Each dispatch starts a real agent run in a terminal, which spends that agent's tokens doing the work. While any watch column is active, the engine will **not** auto-stop when the board empties, so a stream of incoming plans becomes a stream of automatic agent runs until you stop it manually with the automation button. (Sitting idle costs nothing — the cost is per arrival, one agent run each.) Use **Drain** (default) for a finite batch that should stop when finished; use **Watch** for entry columns like CREATED or for remote-control hand-offs where plans arrive over time.

Per-row, also give each toggle a `title`/tooltip: *"Watch: fire on arrival, never auto-stop. Drain: process current cards, then stop."*

**5d. Running-state affordance.** When the engine is running with at least one active watch column, reflect it in the automation button tooltip / status text (e.g. "Automation running — watching {N} column(s)") so the user understands the engine is *intentionally* staying on rather than stuck. This is a persistent, user-meaningful state (not a sub-second race), so a status string is warranted.

## Verification Plan

### Automated Tests

None required as part of this plan. Per session directives, the test suite is run separately by the user; no automated tests (unit, integration, or e2e) are authored or run here. The feature is verified manually via an installed VSIX (per workspace `CLAUDE.md`, not `dist/`):

1. **Drain unchanged (regression):** Multi-column, all columns `Drain`. Start automation with cards present; confirm it dispatches oldest-first and **auto-stops** with the "no more valid tickets" notice once the board drains. (Proves the guard doesn't break the default.)
2. **CREATED watch:** Set CREATED → `Watch`, start automation with CREATED empty. Confirm the engine **stays running**. Drop a new plan into CREATED (create a plan file) → it dispatches to the Planner **within ~1s**, not after the interval.
3. **Remote-control hand-off:** Set the coder source column → `Watch`. Plan a card, then flip its status so it moves into that column. Confirm the coder fires on arrival while other columns stay drain.
4. **Mixed mode:** CREATED `Watch` + back-half `Drain`. Confirm the engine never auto-stops (watch present), drain columns still clear their cards, and the risk callout is visible.
5. **Session cap still stops:** With a watch column active, set a low `globalSessionCap`; confirm cap exhaustion **still** stops the engine (watch does not override budget).
6. **Burst:** Import several plans into a watch CREATED at once; confirm a single coalesced tick dispatches up to `batchSize` and no duplicate dispatches occur.
7. **Persistence:** Set Watch, reload the window; confirm `triggerMode` survives and the engine resumes watching.
8. **Re-import no false nudge (the §3a gate):** With CREATED set to `Watch` and the engine running, trigger a re-import of an existing plan that is already in `PLAN REVIEWED` (e.g. touch the plan file so `GlobalPlanWatcherService` re-runs `insertFileDerivedPlan`). Confirm **no** planner dispatch fires for that plan — the ON CONFLICT path must not emit a CREATED arrival.
9. **Last watch removed:** With the board empty and a watch column active, switch that column back to `Drain` (or disable it). Confirm the engine auto-stops within ≤60 s (next sweep) with the normal "no more valid tickets" notice.

---

**Recommendation:** Complexity 6/10 → **Send to Coder**.
