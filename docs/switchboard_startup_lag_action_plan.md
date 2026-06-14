# Switchboard Startup Lag — Action Plan

## P1. mtime short-circuit in [_handlePlanFile](cci:1://file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/GlobalPlanWatcherService.ts:435:4-561:5) (GlobalPlanWatcherService.ts)
Skip per-file read/parse/upsert/ClickUp-sync for plans that are already
in the DB AND unchanged on disk.
- Guard the EXISTING-plan branch only (after the `getPlanByPlanFile` lookup).
- If `fileStats.mtime <= plan.updatedAt` → skip the work.
- New files (no DB row) fall through to insert — so "catch plans made
  between opens" is fully preserved.
- DB-only edits (Kanban moves) bump `updated_at` past disk mtime, so they're
  preserved too.
- ❌ Dropped earlier idea of gating [triggerScan](cci:1://file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/GlobalPlanWatcherService.ts:593:4-623:5) on `hasActivePlans` — it
  would have killed the between-opens detection.

## P2. Unblock terminal registry sync (extension.ts)
[syncTerminalRegistryWithState()](cci:1://file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts:1501:4-1519:5) is on the critical path with a 5s PID timeout.
- Convert off the legacy state.json bridge → read `runtime.terminals` from db directly.
- Early-exit if no terminals registered.
- Delete the dead 3× JSON-parse retry loop (bridge can't produce truncated JSON).
- Remove `await` on startup; run it inside `deregisterAllTerminals(true).then()`.
- Reduce PID resolution timeout 5000ms → 1000ms.

## P3. Lazy activation (package.json) — highest impact, most testing
Swap `"onStartupFinished"` for view/command-triggered activation:
  `onView:switchboard-view`, `onCommand:switchboard.openKanban`, `onCommand:switchboard.setup`
- Verify background timers (integration auto-pull, plan scanner) still behave.

## P4. Low-effort cleanup (do alongside)
- Add `console.time` checkpoints around the 4 heavy ops for visibility.
- Defer heavy imports (jsdom, sql.js, API wrappers) into `resolveWebviewView()`
  via dynamic `import()`.

## Suggested order
P1 + P2 first (safe, high ROI, no activation-semantics change) → P3 (high impact,
more testing) → P4 folded in.