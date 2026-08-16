# Delete the Attended Oversight Pass

## Goal

Remove `OversightPassService` and its three routes. Attended automation earns nothing over a schedule: it does what scheduled mode does while requiring a human to sit and watch it.

### Why

**It is the same machine as scheduled automation, minus the autonomy.** A pass resolves a queue and runs it — coding lane at WIP 1, planner lane overlapping on a cooldown — while an agent polls `GET /oversight/status` and narrates. Scheduled mode runs the same board transitions on a clock and needs nobody present. The only thing the pass adds is the requirement that you watch.

**Its two lanes are a second implementation of the orchestrator's tick.** Same shape, two codebases: one in the extension driven by an attended session, one in an agent persona driven by an interval. The pass's queue also resolves **once at start**, so a plan arriving mid-pass is invisible to it — the tick re-derives every wake, which is strictly better for any board that changes.

**It is a fourth exclusive automation mode that never appears in the mode selector.** The system already knows it is exclusive: `OversightPassService.start()` returns **409** when automation is armed. That exclusivity is enforced in code and invisible in the UI, which is what makes it feel like a hidden mode rather than a feature.

**Name collision, for anyone reading the history.** "Oversight" names two different things — the oversight *agent* (`orchestrationConfig.enabled`, retired into agent-managed mode) and this oversight *pass*. `feature_plan_20260816150001_oversight-stops-being-a-mode.md` retired the first and deliberately protected the second. This plan retires the second. They are unrelated mechanisms that share a word.

## What is deleted

- **`src/services/OversightPassService.ts`** — 797 lines.
- **Three routes** on `LocalApiServer`: `POST /oversight/start`, `GET /oversight/status`, `POST /oversight/stop`, and their handler wiring.
- **The `isAutomationArmed` closure** (`TaskViewerProvider.ts:1078`). Its only consumer is the pass's 409 guard — nothing else reads it. It goes with the pass.
- **The service's lifecycle wiring** in `TaskViewerProvider` and `extension.ts`: construction, `attachWatcher`, `resumeFromDisk`.
- **The durable state files** `oversight-state.md` and `oversight-log.md`, and the resume-an-interrupted-pass offer that reads them.
- **§6 and §7 of the `/switchboard` skill** — already going with `switchboard-skill-becomes-a-launcher.md`; this removes the reason to relocate them anywhere.

Check `GlobalPlanWatcherService` for the completion hook the pass registered and remove only the pass's own subscription — the watcher itself is load-bearing for plan-file completion detection and stays.

## What replaces it

Nothing new. "Run it now while I watch" is scheduled mode with a short interval and the board open.

## Migration

None expected — the pass has not shipped in a released version. If it has, the only on-disk residue is `oversight-state.md` / `oversight-log.md` in `.switchboard/`, which become orphaned files rather than broken state: nothing reads them once the resume offer is gone. Leave them; do not add a cleanup pass for two inert markdown files.

## Metadata

**Complexity:** 4
**Tags:** refactor, backend, deletion

## Verification Plan

1. `POST /oversight/start` returns 404 — the route is gone, not merely disabled.
2. No file under `src/` references `OversightPassService`, `isAutomationArmed`, `oversight-state` or `oversight-log`.
3. The extension activates cleanly with no oversight wiring, and `GlobalPlanWatcherService` still fires plan-file completion for ordinary dispatches.
4. Scheduled mode still advances cards on its interval, unaffected.
5. Agent-managed mode still dispatches, unaffected — the 409 it used to trip no longer exists because there is nothing to guard against.
6. A workspace carrying a stale `oversight-state.md` opens normally and nothing offers to resume anything.
7. `catalog:check` and `verb-returns:check` pass with the three routes removed.

