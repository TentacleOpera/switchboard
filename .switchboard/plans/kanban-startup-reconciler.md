# Kanban Startup Reconciler for Remote Plan Status Changes

**Plan ID:** b9278529-ab6b-4d51-bc3b-4d48b6aecd25

## Goal

On IDE startup, run **one** reconciling remote poll so kanban cards advance from Linear/Notion status changes made by a remote agent while the machine was off — without the user having to manually "start pinging."

### Ground truth (verified against `src/services/RemoteControlService.ts`, 2026-07-01 audit)

An earlier version of this plan — including its own "corrections" — was written against assumptions that are **not in the code**. Verified reality:

- **There is no auto-start on boot.** `RemoteControlService` starts *only* when the user clicks the webview "start" button, which calls `start()`. Nothing polls at IDE activation.
- **`start()` already does the reconcile.** Its own comment: *"Start pinging. If silentSync is off, run a reconciling sync first."* So `start()` runs one `_poll()` (when `silentSync` is off) and then schedules the recurring timer.
- **There is no `restoreFromConfig`, no `pingMode`, no `manual`/`constant` modes.** Those were fabricated in the prior draft. Config is just `{ provider, boards, silentSync, pingFrequencySeconds }` (`DEFAULT_REMOTE_CONFIG`, line 45).
- **`_poll()` already does the whole cycle:** fetch state + comment deltas since the persisted cursors (`remote.stateCursor.${kind}` / `remote.commentCursor.${kind}`), import remotely-authored plans (`importRemotePlan`), map remote state → kanban column, move the card, **dispatch the destination column's agent**, refresh the local plan file from the remote body, advance the cursors — with the echo guard (`targetColumn === plan.kanbanColumn` no-op), seed-on-first-poll (baseline to `now`, no history replay), and the `_polling` re-entrancy guard.

**So the gap is narrow and singular:** the full reconcile logic exists and is correct, but nothing invokes it at startup — it only runs when the user manually starts pinging. A one-shot poll at activation closes that.

### No migration

The entire remote-sync surface is **experimental and has never shipped in a released version** — no one is using it. Per the project rule, this is a **clean break: no migration, no compat shims, no cursor/key preservation logic.**

## Approach

Add a public one-shot entry that runs a single `_poll()` without starting the timer, and call it once per workspace root at startup. Reuse the existing cursors, echo guards, seed-on-first-poll, and import logic — no parallel pipeline, no new config key.

## Metadata

**Complexity:** 3
**Tags:** backend, reliability, feature

## User Review Required

**Should the startup reconcile dispatch column agents, or only move cards?** Reusing `_poll()` inherits its dispatch behavior — a card that genuinely moved remotely will trigger its destination column's agent at startup.

- **Recommended:** reuse `_poll()` → dispatch. Consistent with what happens today when the user starts pinging manually; echo-guarded (only cards whose column actually changed dispatch); seed-on-first-poll means a fresh install processes nothing. Minimal code.
- **Alternative (more work):** card-move-only, requiring a new no-dispatch variant of the mirror path. Only justified if startup dispatch storms prove to be a real problem.

## Proposed Changes

### `src/services/RemoteControlService.ts` — add `reconcileOnce()`
A public method that runs a single `_poll()` cycle **without** setting the service active or scheduling the timer. Place it next to `start()`.

```typescript
/**
 * One-shot reconciliation: run a single poll cycle (state + comments) without
 * starting the recurring timer or marking the service active. Called at IDE
 * startup so cards advance from remote status changes accumulated while the
 * machine was off. Reuses the existing cursors, echo guards, seed-on-first-poll,
 * and import logic — no parallel pipeline, no new key.
 */
public async reconcileOnce(): Promise<void> {
    await this._poll();
}
```

### `src/services/KanbanProvider.ts` — add `reconcileRemoteOnStartup(workspaceRoot)`
A public passthrough that resolves the per-root `RemoteControlService` (via the existing `_getRemoteControl()`) and calls `reconcileOnce()`, wrapped in try/catch so one root's failure doesn't block others.

### `src/services/TaskViewerProvider.ts` — call it during startup
Inside `initializeKanbanDbOnStartup()`'s per-workspace-root loop, after the DB is bootstrapped and before orphan detection, call `this._kanbanProvider?.reconcileRemoteOnStartup(workspaceRoot)` (guarded, inside the existing per-root try/catch). This runs during `activate()` before the webview loads, so it always executes.

## Edge Cases

- **Remote control unconfigured** → `_poll()` returns early on empty `boards` / no provider. Clean no-op.
- **No cursor yet** → seed-on-first-poll baselines to `now` and processes nothing. No history replay.
- **Network failure** → caught inside `_poll()`; the call-site try/catch prevents blocking startup.
- **User then clicks "start" manually** → the `_polling` re-entrancy guard prevents overlapping cycles; whichever finishes first advances the cursor, the other no-ops.
- **`silentSync` on** → matches `start()` semantics: if the intent is to suppress auto-activity, gate the startup reconcile on `!silentSync` too so behavior is consistent with manual start.

## Verification (suite run separately by the user)

1. **Unit — `reconcileOnce()` delegates to `_poll()`:** fake provider + DB; assert state deltas are fetched/applied, the service does **not** become active, and no timer is scheduled.
2. **Unit — no-op when unconfigured:** empty `boards` → no delta fetch, no throw.
3. **Unit — seed-on-first-poll:** no existing cursor → cursor baselined to `now`, zero deltas processed.
4. **Manual:** configure Linear/Notion remote control, change a linked issue's status remotely with the IDE closed, restart, confirm the card advances once (and its agent dispatches, per the User Review decision) with no duplicate.

**Recommendation:** Complexity 3 — a small wrapper across three files delegating to existing, tested infrastructure. The only real decision is dispatch-at-startup (above).
