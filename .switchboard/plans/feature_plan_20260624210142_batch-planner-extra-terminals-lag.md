# Fix: Batch Planner "Extra Terminals" Dispatch Is Laggy (kanban.html Agents Tab)

## Goal

In the Agents tab of `kanban.html` there is a planner **"Terminals"** count selector (1–5) — [kanban.html:2689-2702](../../src/webview/kanban.html#L2689-L2702) — that distributes a batch of plans across multiple planner terminals ("extra terminals"). When this is set above 1 and a batch is advanced, the dispatch feels **very laggy**: the board, the toast, and the terminals all take a long, visibly serial time to update.

The goal is to remove the unnecessary serialization so multi-terminal batch dispatch completes in roughly the time of a single terminal's send, not N × (per-send fixed delays).

> **Related:** this lag is also what turns the "advance all" bounce-back into a *permanent* loss of the move — see [feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md](feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md). That plan makes the column move persist immediately (independent of dispatch); this plan removes the dispatch latency. Land both together for the complete remedy.

### Problem Analysis & Root Cause

The "extra terminals" feature routes through `_distributePlannerDispatch` ([KanbanProvider.ts:3355](../../src/services/KanbanProvider.ts#L3355)). It round-robins the selected plans into one bucket per live planner terminal, then dispatches the buckets **sequentially with `await`**:

```js
// Dispatch per bucket with per-bucket failure isolation
for (const [terminalName, ids] of buckets) {
    try {
        await vscode.commands.executeCommand(
            'switchboard.triggerBatchAgentFromKanban',
            'planner', ids, 'improve-plan', workspaceRoot, terminalName
        );           // <-- each bucket fully completes before the next starts
    } catch (err) { ... }
}
```

Each bucket dispatch eventually reaches the terminal-send layer, which is gated by **hardcoded fixed delays** that exist to let CLI agents settle:

- `_executeLocal` ([TaskViewerProvider.ts:14785-14787](../../src/services/TaskViewerProvider.ts#L14785-L14787)) sends the command, then `await new Promise(r => setTimeout(r, 1000))`, then submits a newline. A flat **1000 ms per send**.
- When **clear-before-prompt** is enabled (default ON — `terminal.clearBeforePrompt`, [TaskViewerProvider.ts:15353](../../src/services/TaskViewerProvider.ts#L15353)), each dispatch *additionally* pastes `/clear`, waits `paced ? 1000 : 100` ms, submits, then waits `clearDelay` (default **2000 ms**) before the prompt ([TaskViewerProvider.ts:15358-15371](../../src/services/TaskViewerProvider.ts#L15358-L15371)).

So the per-plan cost when paced is on the order of **3 seconds** (1s clear-submit + 2s clear-settle + the 1s send delay), and because the buckets — and the plans within each bucket's batch — are processed with sequential `await`, the total wall-clock time is **additive across every plan and every terminal**. Five terminals with five plans isn't "5 parallel sends"; it's ~25 × 3s of serialized waiting. That is the lag.

**Root cause, precisely:** the multi-terminal design implies parallelism (the whole point of extra terminals is concurrent throughput), but the implementation dispatches buckets — and the sends inside them — strictly serially, and each send carries multi-second fixed `setTimeout` settle delays. The delays are appropriate *per terminal* but should overlap *across terminals*, since different terminals are independent processes.

### Net effect

Distinct terminals never need to wait for each other. The fix is to dispatch the buckets concurrently (one independent send pipeline per terminal) so the fixed settle delays overlap instead of stack, while preserving the per-terminal pacing that the CLI agents actually need.

## Metadata

- **Tags:** `bug`, `performance`, `kanban`, `terminals`, `dispatch`, `KanbanProvider`, `TaskViewerProvider`
- **Complexity:** 5/10

## Complexity Audit

**Complex / Risky.** The fix changes dispatch concurrency in the terminal-send layer, which is timing-sensitive: the fixed delays exist because some CLI agents (copilot, claude) mis-handle text that arrives too fast or concatenate `/clear` with the following prompt. Parallelizing **across** terminals is safe (independent processes). Parallelizing **within** a single terminal's batch is NOT safe and must be preserved as serial. The risk is introducing interleaving that corrupts a single terminal's input stream, so the parallelism boundary must be exactly "one concurrent pipeline per terminal."

## Edge-Case & Dependency Audit

- **Per-terminal serialization must hold.** Within one terminal, plans must still be sent one-at-a-time with the existing pacing — two prompts racing into the same PTY will concatenate. Only *different* terminals may run concurrently.
- **Clear-before-prompt ordering.** The `/clear` → settle → prompt sequence for a given terminal must remain strictly ordered. Parallelizing across terminals keeps this intact (each terminal owns its own sequence); do not parallelize the steps within a terminal.
- **Dispatch dedupe lock.** `_handleTriggerAgentActionInternal` uses a `_recentActionDispatches` dedupe keyed by `role::sessionId::...` with a 2500 ms TTL ([TaskViewerProvider.ts:15397-15402](../../src/services/TaskViewerProvider.ts#L15397-L15402)). Concurrent buckets dispatch *different* sessionIds, so keys won't collide — but confirm the lock isn't keyed on terminal or role alone anywhere in the batch path.
- **Failure isolation.** The current `try/catch` per bucket must be preserved so one terminal failing doesn't abort the others. With `Promise.allSettled`, each bucket's rejection is captured independently.
- **Optimistic move + status toast.** `_distributePlannerDispatch` pre-moves cards and posts a summary toast *after* the loop ([KanbanProvider.ts:3392-3427](../../src/services/KanbanProvider.ts#L3392-L3427)). With parallel dispatch, the toast should fire after `allSettled` resolves; the optimistic move already happens up front so the board updates immediately regardless.
- **Terminal count vs live terminals.** `getAliveRoleTerminalNames` returns only live terminals ([TaskViewerProvider.ts:3444](../../src/services/TaskViewerProvider.ts#L3444)); if fewer terminals are alive than the configured count, round-robin still works and parallelism is bounded by live terminals. No change needed.
- **Limit-dispatch toggle.** The "Limit dispatches to number of available terminals" option ([kanban.html:2698](../../src/webview/kanban.html#L2698)) caps plans to `terminals.length`; orthogonal to this fix.
- **Do not reduce the delays blindly.** The 1000 ms / 2000 ms values are there for CLI-agent correctness. The fix is overlap, not removal. (A separate, optional follow-up could make `clearDelay` configurable lower — it already is via `terminal.clearBeforePromptDelay` — but that's a user setting, not part of this fix.)

## Proposed Changes

### File 1: `src/services/KanbanProvider.ts`

**Parallelize the per-bucket dispatch in `_distributePlannerDispatch` ([KanbanProvider.ts:3408-3418](../../src/services/KanbanProvider.ts#L3408-L3418)).** Replace the sequential `for...await` with concurrent dispatch, one pipeline per terminal, joined by `allSettled`:

```js
// Dispatch buckets concurrently — distinct terminals are independent processes,
// so their per-send settle delays should overlap, not stack. Sends WITHIN a
// single terminal's batch remain serial inside triggerBatchAgentFromKanban.
const bucketResults = await Promise.allSettled(
    [...buckets.entries()].map(([terminalName, ids]) =>
        vscode.commands.executeCommand(
            'switchboard.triggerBatchAgentFromKanban',
            'planner', ids, 'improve-plan', workspaceRoot, terminalName
        )
    )
);
bucketResults.forEach((r, i) => {
    if (r.status === 'rejected') {
        const terminalName = [...buckets.keys()][i];
        console.error(`[KanbanProvider] Distribute dispatch to '${terminalName}' failed:`, r.reason);
    }
});
```

The optimistic pre-move and `moveCards` post ([3392-3398](../../src/services/KanbanProvider.ts#L3392-L3398)) stay before this block, so the board updates instantly. The summary toast ([3420-3427](../../src/services/KanbanProvider.ts#L3420-L3427)) stays after, now firing once all terminals finish in parallel.

### File 2: `src/services/TaskViewerProvider.ts`

**Confirm `triggerBatchAgentFromKanban` serializes *within* a terminal, not across the whole command.** Inspect the batch handler that fans out to `_handleTriggerAgentActionInternal` / `_executeLocal`. The required invariant after the change:

- Plans destined for the **same** terminal are sent serially (preserve existing `await` in the per-terminal loop).
- The fixed `setTimeout` pacing in `_executeLocal` ([14786](../../src/services/TaskViewerProvider.ts#L14786)) and the clear sequence ([15358-15371](../../src/services/TaskViewerProvider.ts#L15358-L15371)) are untouched — they now run concurrently across terminals because each `executeCommand` invocation from File 1 is its own async chain.

No code change is expected here *if* `triggerBatchAgentFromKanban` already scopes its loop to a single terminal per invocation (it receives one `terminalName`). Add a short comment documenting that concurrency across invocations is now relied upon, so a future refactor doesn't reintroduce a global send lock.

**Optional micro-optimization (only if still laggy on a single terminal):** the trailing `await new Promise(r => setTimeout(r, 1000))` in `_executeLocal` between `sendText(cmd, false)` and `sendText('', true)` is a flat 1s. If profiling shows this dominates single-terminal batches, gate it behind the same `paced` flag used elsewhere (`paced ? 1000 : 250`) rather than a constant. Treat as a follow-up, not core to the lag fix.

## Verification Plan

**Step 1 — Reproduce the baseline.** Set planner Terminals = 4 in the Agents tab, ensure 4 live planner terminals exist, select ~8 plans in a planner-source column, and advance-all. Time the wall-clock from click to "Distributed N plan(s) across 4 planner terminal(s)" toast. With clear-before-prompt ON this should currently be on the order of tens of seconds.

**Step 2 — Apply File 1 and re-measure.** Same scenario. Expected: total time drops to roughly the longest single terminal's chain (≈ ceil(8/4) plans × per-send cost), not the sum across all terminals. Confirm all 4 terminals receive their prompts and each prompt is intact (no `/clear` concatenation, no two prompts merged in one terminal).

**Step 3 — Single-terminal integrity.** Set Terminals = 1, advance 3 plans. Confirm they arrive one-at-a-time, correctly cleared and submitted — i.e. the per-terminal serial pacing is unchanged.

**Step 4 — Failure isolation.** Close one of the 4 planner terminals mid-test (or point a bucket at a non-existent terminal). Confirm the other 3 still dispatch and the error is logged for the failed one only (no aborted batch).

**Step 5 — Optimistic board update.** Confirm the cards visually advance immediately on click (the pre-move), independent of how long the terminal sends take — proving the board is no longer blocked on the serial dispatch.

**Step 6 — Build & install.** Build the extension, reload, and re-run Step 2 against the installed extension to confirm the timing improvement is real and not a `dist/` artifact.
