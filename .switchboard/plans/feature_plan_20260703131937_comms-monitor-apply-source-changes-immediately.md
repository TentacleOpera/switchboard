# Comms Monitor: Apply Source Changes Immediately Without Terminal Restart

## Goal

When the user checks or unchecks source checkboxes (Slack, Gmail, Calendar, Custom) in the AUTOMATION tab while the monitor terminal is already running, the change should take effect on the very next prompt — without restarting the terminal. Currently, adding a source mid-stream has no visible effect until the user shuts down and relaunches the terminal, which is confusing and bad UX.

> **Line-anchor note (verified 2026-07-03):** All line numbers in the original draft had drifted ~90 lines upward relative to the current `src/services/TaskViewerProvider.ts`. Anchors below have been re-verified against the live code. Symbols are stable; trust the symbol names over any number if the file drifts again. Corrected mapping:
> - `setMcpMonitorConfigFromKanban` → **20573** (was 20481)
> - `_startMcpMonitorLoop` → **20482** (was 20390/20483); clears + re-sets the interval at **20488–20492**; `enabled`-false short-circuit at **20484–20487**
> - `_stopMcpMonitorLoop` → **20495** (was 20403)
> - `_enqueueMcpMonitorTick` → **20502** (serializes ticks onto `_mcpMonitorTickQueue`)
> - `_mcpMonitorTick` → **20512** (was 20420); fresh-config read at **20513**, `enabled` early return at **20514**, dead-terminal guard at **20524**, in-flight guard (`_mcpMonitorInFlight`) at **20530**, secondary debounce (`intervalMs * 0.5`) at **20536**, `_mcpMonitorLastSendAt = Date.now()` at **20545**
> - `_buildMcpMonitorPrompt` returns `''` on empty sources at **20568** (was 20476)
> - `launchMcpMonitorTerminal` → **20604** (was 20512)
> - Timer/state fields → **358–361** (this anchor was already correct): `_mcpMonitorTimer` (358), `_mcpMonitorTickQueue` (359), `_mcpMonitorLastSendAt` (360), `_mcpMonitorInFlight` (361)

### Problem Analysis & Root Cause

**Symptom:** The monitor terminal is running. The user checks the Gmail checkbox (in addition to the already-checked Slack). No new prompt appears. The user waits, sees nothing change, concludes the feature is broken, and restarts the terminal — at which point the new source finally appears in the prompt.

**Root cause (confirmed by code reading):** Two compounding issues in the config-change path:

1. **No immediate tick on config change.** `setMcpMonitorConfigFromKanban` (line 20573) saves the config via `GlobalIntegrationConfigService.setMcpMonitorConfig`, then calls `_startMcpMonitorLoop()` (line 20575). `_startMcpMonitorLoop` (line 20482) **clears the existing interval and sets a new one** (lines 20488–20492). `setInterval` does not fire immediately — the next tick is a full `intervalMs` away (default 5 minutes). So the user's source change is persisted to disk but no prompt is sent for up to 5 minutes. There is no call to `_enqueueMcpMonitorTick()` in the config-change path.

2. **Debounce would block an immediate tick even if we added one.** Even if `setMcpMonitorConfigFromKanban` enqueued a tick, `_mcpMonitorTick` (line 20512) has a secondary debounce guard at line 20536: `if (Date.now() - this._mcpMonitorLastSendAt < intervalMs * 0.5) return;`. If a tick fired recently (within 2.5 minutes for a 5-minute interval), the immediate tick would be silently discarded. So the user could add a source, see the tick fire (in logs), but get no prompt because the debounce ate it.

**Why restarting "fixes" it:** `launchMcpMonitorTerminal` (line 20604) creates a fresh terminal and (per the companion plan **first-prompt-after-startup**) schedules a one-shot first prompt shortly after startup. That one-shot calls `_enqueueMcpMonitorTick` → `_mcpMonitorTick`, which reads fresh config from disk (line 20513: `const cfg = await GlobalIntegrationConfigService.getMcpMonitorConfig()`). The fresh config has the new sources, so the prompt includes them. The user concludes "restart fixes it" — but the real issue is that config changes don't trigger an immediate tick.

**Key observation:** `_mcpMonitorTick` already reads fresh config from disk on every tick (line 20513). The config IS persisted correctly by `setMcpMonitorConfig`. The only problem is timing — no tick is triggered when config changes, and the debounce would block it if it were.

## Metadata

- **Tags:** bugfix, ux, reliability, backend
- **Complexity:** 4
- **Repo:** switchboard (root; no bare sub-repo)
- **Project:** switchboard
- **Files touched:** `src/services/TaskViewerProvider.ts`
- **Domain labels (non-schema, for humans):** comms-monitor, mcp-monitor, automation, kanban, config-change

## User Review Required

- **Coalescing window (500ms):** Confirm 500ms is an acceptable delay between the final checkbox toggle and the prompt appearing. It must be long enough to merge rapid multi-source toggles into one tick, short enough to feel "immediate." No config setting is proposed for this; it is a hard-coded constant.
- **Debounce reset semantics:** This plan resets `_mcpMonitorLastSendAt = 0` when the config-change tick fires so the tick is not swallowed by the secondary debounce. Confirm it is acceptable that an explicit config change can produce a prompt shortly after a regular interval prompt (i.e. two prompts closer together than `intervalMs * 0.5`). The rationale: a config change is a deliberate user action, so an immediate prompt is intended.
- **Shared-surface coordination (epic-level):** This plan edits `_stopMcpMonitorLoop` and the `setMcpMonitorConfigFromKanban` call site, which sibling plans **first-prompt-after-startup** and **stuck-running-status-and-stop-control** also modify. Confirm the merge/sequencing approach in `## Edge-Case & Dependency Audit → Dependencies & Conflicts` before parallel execution.

## Complexity Audit

### Routine
- Single-file change, entirely within `src/services/TaskViewerProvider.ts`.
- Reuses patterns already present in the file: `setTimeout`/`clearTimeout` for debounced actions (cf. `_recentMirrorProcessed`, `_autobanEmptyColumnSweepTimer`), `_enqueueMcpMonitorTick` for serialized ticks, and the existing `_stopMcpMonitorLoop` cleanup pattern.
- No schema changes, no UI/webview changes, no persisted-state changes, no migrations.
- The new field `_mcpMonitorConfigChangeTimer` mirrors the existing `_mcpMonitorTimer` field idiom exactly.

### Complex / Risky
- **Shared-surface edit collision.** `_stopMcpMonitorLoop` (20495) and the `setMcpMonitorConfigFromKanban` body (20573) are also touched by sibling plans in this epic (see Dependencies & Conflicts). This is a merge/coordination risk, not intrinsic algorithmic complexity — it is the reason complexity is 4 rather than 3.
- **Debounce-clock mutation.** Resetting the shared `_mcpMonitorLastSendAt` field from the config-change path is a deliberate cross-cutting side effect on state that the regular interval tick also reads/writes. Must not be generalized beyond the config-change tick.

## Edge-Case & Dependency Audit

### Race Conditions
- **Rapid checkbox toggling:** The user checks Slack, then Gmail, then Calendar in quick succession. Each checkbox `change` event calls `saveMonitorConfig` → `postKanbanMessage({ type: 'setMcpMonitorConfig', ... })` → `setMcpMonitorConfigFromKanban`. Without coalescing, this enqueues 3 ticks, each reading progressively more sources; the first sends a prompt with only Slack+Gmail, the rest are debounce-blocked, and Calendar never appears. **Fix:** a 500ms `setTimeout` in `setMcpMonitorConfigFromKanban` that clears any pending timer before setting a new one, so all rapid changes coalesce into a single tick that reads the final config with all sources.
- **Interval tick vs. config-change tick interleave:** Both paths funnel through `_enqueueMcpMonitorTick`, which serializes work onto `_mcpMonitorTickQueue` (line 20503). Ticks therefore never execute concurrently; the in-flight guard (line 20530) is a second line of defense. Ordering between a queued interval tick and a queued config-change tick is FIFO on the promise chain — acceptable because both read fresh config at line 20513.
- **Async gap in `setMcpMonitorConfigFromKanban`:** `setMcpMonitorConfig` and `_startMcpMonitorLoop` are both `await`ed before the timer is scheduled, so the config is guaranteed persisted to disk before the coalesced tick reads it 500ms later. No read-before-write race.

### Security
- No new external input, no new IPC surface, no new file writes. The prompt content is built from already-validated persisted config via the existing `_buildMcpMonitorPrompt`. No security impact.

### Side Effects
- **Debounce bypass:** The coalesced tick resets `_mcpMonitorLastSendAt = 0` so it is not blocked by the secondary debounce (line 20536). This is a deliberate one-directional side effect on shared timing state; it only makes an *extra* prompt possible, never suppresses a scheduled one. Safe — the user explicitly changed config, so an immediate prompt is intentional.
- **In-flight guard:** If a regular interval tick is in-flight when the config-change tick fires, the in-flight guard (line 20530) causes the config-change tick to skip. Acceptable — the in-flight tick reads fresh config (line 20513), so it already includes the new sources. The config-change tick is a best-effort immediate trigger.
- **Monitor disabled during the 500ms window:** If the user unchecks all sources or disables the monitor within the window, the tick reads config (line 20513), sees `enabled: false` or empty sources, and returns early (line 20514 / `_buildMcpMonitorPrompt` returns `''` at line 20568). No stray prompt.
- **Terminal dies during the 500ms window:** The tick's dead-terminal guard (line 20524) returns early. No error.
- **Timer cleanup on stop:** The coalescing timer must be cleared in `_stopMcpMonitorLoop` (line 20495) to avoid a stray tick after the monitor is disabled.
- **No `confirm()` dialogs / no UI changes** — pure backend timing fix.

### Dependencies & Conflicts
- **Sibling `first-prompt-after-startup`** schedules a one-shot first-prompt tick (via `launchMcpMonitorTerminal`, 20604) and, per its plan, adds its own timer that must be cancelled in `_stopMcpMonitorLoop`. **Shared surface:** `_stopMcpMonitorLoop` (20495) will be edited by both plans to add distinct `clearTimeout` calls. These are additive and non-conflicting *in intent* but WILL produce a textual merge conflict in the same method body. Reconcile into a single cleanup block that cancels all monitor timers (`_mcpMonitorTimer`, the first-prompt one-shot, and `_mcpMonitorConfigChangeTimer`).
- **Sibling `stuck-running-status-and-stop-control`** adds/cancels timers and schedules ticks around the same monitor lifecycle, and adds a stop control. **Shared surface:** `_stopMcpMonitorLoop` and possibly `_startMcpMonitorLoop`. Same merge-conflict class as above.
- **Sibling `per-source-intervals`** changes how the interval is computed. **Shared surface:** the `intervalMs` derivation (line 20491) and the debounce `intervalMs * 0.5` (line 20536). If per-source intervals land, this plan's debounce-reset behavior still holds (reset-to-0 is interval-agnostic), but re-verify that the debounce comparison remains meaningful under a multi-interval model.
- **Coordination recommendation:** Treat `_stopMcpMonitorLoop`, `_startMcpMonitorLoop`, the `setMcpMonitorConfigFromKanban` body, and the timer-field block (358–361) as **shared surfaces owned by the epic, not by any single subtask.** Land whichever timer-lifecycle sibling first, then rebase the others so each merely *adds its own `clearTimeout`/field* to an agreed-upon consolidated cleanup block. Do NOT let any one subtask unilaterally rewrite these methods' structure.

## Dependencies

- `sess_firstpromptafterstartup — companion one-shot first-prompt tick; shares `_stopMcpMonitorLoop` cleanup and `launchMcpMonitorTerminal`.`
- `sess_stuckrunningstatusstop — shares monitor timer lifecycle (`_stopMcpMonitorLoop`, stop control).`
- `sess_persourceintervals — may change `intervalMs` derivation feeding the secondary debounce.`

(Session IDs above are placeholders for the sibling subtask plans in this epic; replace with real `sess_XX␣` IDs if/when linking in the board. No blocking dependency on non-epic sessions.)

## Adversarial Synthesis

**Risk Summary:** Key risks — (1) merge collisions on the shared monitor-timer lifecycle (`_stopMcpMonitorLoop`, `setMcpMonitorConfigFromKanban`, fields 358–361) with three sibling plans; (2) the deliberate `_mcpMonitorLastSendAt = 0` debounce reset producing a prompt close on the heels of an interval prompt; (3) a stray tick if the coalescing timer is not cancelled on stop. Mitigations — treat the timer lifecycle as an epic-owned shared surface and consolidate all `clearTimeout` calls into one cleanup block; scope the debounce reset strictly to the config-change tick; add `_cancelMcpMonitorConfigChangeTick()` to `_stopMcpMonitorLoop`; and short-circuit scheduling when `enabled === false`.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — add a config-change coalescing timer field

Add next to the existing MCP monitor timer fields (**lines 358–361**, alongside `_mcpMonitorTimer`):

```ts
    private _mcpMonitorConfigChangeTimer?: NodeJS.Timeout;
```

### 2. `src/services/TaskViewerProvider.ts` — enqueue a coalesced immediate tick on config change

In `setMcpMonitorConfigFromKanban` (**line 20573**), schedule the coalesced tick (guarded on `enabled` per Change 4):

```ts
    public async setMcpMonitorConfigFromKanban(config: Partial<McpMonitorConfig>) {
        await GlobalIntegrationConfigService.setMcpMonitorConfig(config);
        await this._startMcpMonitorLoop();
        this._postMcpMonitorConfig();
        // Only schedule an immediate tick if the monitor is enabled —
        // otherwise the tick would fire and no-op on the disabled check.
        if (config.enabled !== false) {
            this._scheduleMcpMonitorConfigChangeTick();
        }
    }
```

> Note: the live method body is exactly `setMcpMonitorConfig` → `_startMcpMonitorLoop` → `_postMcpMonitorConfig` (lines 20574–20576). Insert the guarded schedule call as the last statement; do not reorder the existing three.

### 3. `src/services/TaskViewerProvider.ts` — add the coalescing scheduler + cancel helpers

Add alongside the other MCP monitor helpers (e.g. immediately after `_stopMcpMonitorLoop`, which ends at **line 20500**):

```ts
    /**
     * When the user changes monitor config (sources, interval, etc.) while the
     * terminal is already running, enqueue an immediate tick so the change is
     * reflected in the very next prompt — without requiring a terminal restart.
     * A 500ms debounce coalesces rapid checkbox toggles into a single tick.
     * The debounce clock is reset so the tick isn't blocked by a recent send.
     */
    private _scheduleMcpMonitorConfigChangeTick() {
        if (this._mcpMonitorConfigChangeTimer) {
            clearTimeout(this._mcpMonitorConfigChangeTimer);
        }
        this._mcpMonitorConfigChangeTimer = setTimeout(() => {
            this._mcpMonitorConfigChangeTimer = undefined;
            // Reset the secondary debounce so this tick isn't blocked by a
            // recent interval send. The user explicitly changed config, so an
            // immediate prompt is intentional.
            this._mcpMonitorLastSendAt = 0;
            this._enqueueMcpMonitorTick();
        }, 500);
    }

    private _cancelMcpMonitorConfigChangeTick() {
        if (this._mcpMonitorConfigChangeTimer) {
            clearTimeout(this._mcpMonitorConfigChangeTimer);
            this._mcpMonitorConfigChangeTimer = undefined;
        }
    }
```

### 4. `src/services/TaskViewerProvider.ts` — cancel the coalescing timer when the monitor stops

Extend `_stopMcpMonitorLoop` (**line 20495**) to also cancel the config-change timer. The live method currently only clears `_mcpMonitorTimer`:

```ts
    private _stopMcpMonitorLoop() {
        if (this._mcpMonitorTimer) {
            clearInterval(this._mcpMonitorTimer);
            this._mcpMonitorTimer = undefined;
        }
        this._cancelMcpMonitorConfigChangeTick();
    }
```

**Epic coordination:** siblings `first-prompt-after-startup` and `stuck-running-status-and-stop-control` also add `clearTimeout`/`clearInterval` calls to this same method. Whichever subtask lands first establishes the consolidated cleanup block; later subtasks add only their own line. Do not rewrite the method's shape.

**Disable path interaction:** `setMcpMonitorConfigFromKanban` → `_startMcpMonitorLoop` → (if `!cfg.enabled`) `_stopMcpMonitorLoop` (lines 20484–20487) runs *before* the schedule call in Change 2. So on a disable, `_stopMcpMonitorLoop` cancels any prior config-change timer, and the `config.enabled !== false` guard in Change 2 prevents scheduling a new one. Belt-and-suspenders: even without the guard, a fired tick reads `enabled: false` at line 20514 and returns early — no stray prompt either way. The guard is retained to avoid an unnecessary 500ms timer.

## Verification Plan

### Automated Tests
- `npm run compile` (webpack) succeeds with no TypeScript errors — confirms the new field, method signatures, and call sites are well-typed.
- No unit-test harness currently exercises `_mcpMonitorTick`/`_startMcpMonitorLoop`; behavior is validated via the manual scenarios below. If a lightweight unit test is desired, extract the debounce-reset decision into a pure helper and assert: (a) config-change tick sets `_mcpMonitorLastSendAt = 0`; (b) `_cancelMcpMonitorConfigChangeTick` clears the timer field. (Optional — not required for this routine fix.)

### Manual
1. **Add source mid-stream (the core fix):** Enable the monitor with only Slack checked. Launch the terminal. Wait for the first prompt (companion one-shot or interval). Confirm the prompt contains only the Slack line. While the terminal is still running, check the Gmail checkbox in the AUTOMATION tab. **Within ~1 second** (500ms coalescing + tick processing) a new prompt appears containing both Slack and Gmail lines. No restart needed.
2. **Remove source mid-stream:** With Slack + Gmail active and the terminal running, uncheck Gmail. Confirm the next prompt (within ~1s) contains only the Slack line.
3. **Rapid toggling coalesces:** With the terminal running, rapidly check Slack, Gmail, and Calendar (under 500ms apart). Confirm only **one** new prompt appears (not three) and it contains all three sources.
4. **Debounce bypass works:** Set interval to 1 minute. Let a regular interval tick fire (prompt sent). Immediately check a new source. Confirm a new prompt appears within ~1s even though a tick just fired — the `_mcpMonitorLastSendAt = 0` reset let the config-change tick through.
5. **Disable monitor cancels pending tick:** Check a source, then within the 500ms window switch the monitor off. Confirm no prompt is sent after the 500ms mark (timer cancelled by `_stopMcpMonitorLoop`, and/or the `enabled !== false` guard skips scheduling; the `if (!cfg.enabled) return` at line 20514 is the final backstop).
6. **Terminal dies during coalescing window:** Check a source, then kill the terminal within the 500ms window. Confirm no error is thrown (dead-terminal guard at line 20524 returns early).
7. **In-flight tick already covers the change:** If a regular interval tick is in-flight when a source is checked, the config-change tick may be skipped by the in-flight guard (line 20530). Confirm the in-flight tick's prompt includes the new source (fresh config read at line 20513), or that the config-change tick fires after it with an updated prompt. Either way the user sees the new source without restarting.
8. **Regression:** Regular interval polling continues unchanged. The companion first-prompt one-shot is unaffected. The debounce for regular interval ticks is unchanged (only config-change ticks reset the debounce clock).

---

**Recommendation: Send to Coder** (complexity 4). The change itself is routine, but it edits monitor-timer lifecycle surfaces shared with three sibling subtasks; a Coder should own the merge/sequencing so the shared `_stopMcpMonitorLoop` cleanup is consolidated rather than clobbered.
