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

### Correction — Verified Against Source (2026-06-24)

The original analysis above is directionally correct but contains three inaccuracies confirmed by reading the current source. The fix is unchanged; the *expected magnitude* and *delay attribution* are corrected here so the implementer and the user are not misled.

1. **Per-bucket, not per-plan.** `handleKanbanBatchTrigger` ([TaskViewerProvider.ts:3299-3416](../../src/services/TaskViewerProvider.ts#L3299-L3416)) calls `generateUnifiedPrompt` **once per bucket** and issues **one** `_dispatchExecuteMessage` per terminal ([TaskViewerProvider.ts:3369](../../src/services/TaskViewerProvider.ts#L3369)). There is **no per-plan send loop** in the batch path. A bucket holding 3 plans produces *one* paste, not three. The serial cost is therefore `N_terminals × per-send`, **not** `N_plans × N_terminals × per-send`. The "~25 × 3s" framing overstates the lag; the accurate model is `N_terminals × ~6s` (see timing breakdown below).

2. **The batch send path is `_attemptDirectTerminalPush` + `sendRobustText`, NOT `_executeLocal`.** `_executeLocal` ([TaskViewerProvider.ts:14815-14843](../../src/services/TaskViewerProvider.ts#L14815-L14843)) is invoked from a different webview command handler ([TaskViewerProvider.ts:9210/9215](../../src/services/TaskViewerProvider.ts#L9210)), **not** the kanban batch dispatch. The actual batch path: `handleKanbanBatchTrigger` → `_dispatchExecuteMessage` ([15282](../../src/services/TaskViewerProvider.ts#L15282)) → `_attemptDirectTerminalPush` ([15354](../../src/services/TaskViewerProvider.ts#L15354)) → `/clear` paste sequence ([15413-15426](../../src/services/TaskViewerProvider.ts#L15413-L15426)) + `sendRobustText` ([15429](../../src/services/TaskViewerProvider.ts#L15429)). The command `switchboard.triggerBatchAgentFromKanban` is registered in [extension.ts:1173](../../src/extension.ts#L1173) and delegates to `handleKanbanBatchTrigger`.

3. **The clipboard mutex bounds the speedup — the original plan never mentions it.** Both the `/clear` ([15415](../../src/services/TaskViewerProvider.ts#L15415)) and the payload (for prompts > 100 chars, [sendRobustText:81-84](../../src/services/terminalUtils.ts#L81-L84)) are delivered via `pasteTextViaClipboard`, which is **globally serialized** by `_clipboardLock` ([terminalUtils.ts:5-11](../../src/services/terminalUtils.ts#L5-L11)). Each paste holds the lock ~1000 ms (PRE_PASTE 200 + POST_PASTE 800). Two pastes per bucket ≈ **2000 ms of non-overlappable lock time per terminal**.

**Accurate per-bucket timing (paced, clear-before-prompt ON, payload > 100 chars):**
- Clipboard-locked: `/clear` paste (~1000 ms) + prompt paste (~1000 ms) = **~2000 ms** (serialized across all terminals by `_clipboardLock`)
- Non-locked `setTimeout` settle: 1000 ms (after `/clear` submit, [15417](../../src/services/TaskViewerProvider.ts#L15417)) + `clearDelay` 2000 ms ([15420](../../src/services/TaskViewerProvider.ts#L15420)) + `NEWLINE_DELAY` 1000 ms ([sendRobustText:87/119](../../src/services/terminalUtils.ts#L87)) = **~4000 ms** (these **do** overlap across terminals)

Serial today (N=4): 4 × ~6000 ms ≈ **24 s**. Parallel after fix: the ~4000 ms non-locked delays overlap, but the ~2000 ms clipboard-locked pastes queue → ≈ **8–10 s**. That is a real **~2.5–3× improvement**, but it is **NOT** "single-terminal time" (~6 s). The verification plan's expected timing is corrected accordingly below. The only way to reach true single-terminal time would be to abandon clipboard-paste delivery, which risks PTY line-buffer truncation and is out of scope.

## Metadata

- **Tags:** `bugfix`, `performance`, `ui`
- **Complexity:** 5/10

## User Review Required

Yes. The fix changes dispatch concurrency in a timing-sensitive terminal-send path. A user review of the corrected expected-speedup (≈2.5–3×, bounded by the clipboard mutex — not single-terminal time) is required before implementation, so the acceptance bar is set realistically. No destructive/data-migrating action is involved; review is for behavioral correctness and expectation alignment only.

## Complexity Audit

### Routine
- Replacing a sequential `for...await` loop with `Promise.allSettled` in a single method (`_distributePlannerDispatch`, KanbanProvider.ts:3443-3452). Mechanical, localized.
- Preserving the existing per-bucket `try/catch` failure-isolation semantics via `allSettled` rejection capture.
- The optimistic pre-move + `moveCards` echo (3406-3428) and the summary toast (3457-3464) already bracket the dispatch block; their ordering relative to the parallel dispatch is unchanged.

### Complex / Risky
- **Clipboard-mutex bottleneck (newly identified).** The global `_clipboardLock` (terminalUtils.ts:5-11) serializes all `pasteTextViaClipboard` calls. Concurrent cross-terminal dispatch is safe (the lock prevents clipboard corruption) but the paste portions do NOT overlap. The fix's speedup is bounded by this lock; the user-facing expectation must be tempered to ~2.5–3×, not single-terminal time.
- **Concurrent DB writes across buckets.** `handleKanbanBatchTrigger` runs a per-plan runsheet/column-update loop ([TaskViewerProvider.ts:3347-3363](../../src/services/TaskViewerProvider.ts#L3347-L3363)) before dispatch. With parallel buckets these loops run concurrently, but each touches distinct `sessionId` rows, so no row-level conflict. SQLite/WAL handles same-process concurrent writes. Low risk; noted for completeness.
- **Terminal focus thrash (cosmetic).** Each `_attemptDirectTerminalPush` calls `terminal.show(false)` ([terminalUtils.ts:30](../../src/services/terminalUtils.ts#L30)) under the clipboard lock. Concurrent dispatch may briefly flip focus between terminals. Cosmetic only; no correctness impact.

## Edge-Case & Dependency Audit

- **Per-terminal serialization (reframed — automatically satisfied).** The original concern about sending plans "one-at-a-time within a terminal" is moot for the batch path: `handleKanbanBatchTrigger` sends **one unified prompt per terminal**, not a per-plan loop. The only intra-terminal ordering that must hold is the `/clear` → settle → prompt `await` chain inside `_attemptDirectTerminalPush` ([15413-15429](../../src/services/TaskViewerProvider.ts#L15413-L15429)), which is self-contained within a single `executeCommand` invocation and cannot interleave with another terminal's chain. Parallelizing across `executeCommand` calls cannot break it.
- **Clear-before-prompt ordering.** The `/clear` → settle → prompt sequence for a given terminal remains strictly ordered (each terminal owns its own `await` chain). Do not parallelize the steps *within* a terminal. The fix only parallelizes *across* terminals. Preserved automatically.
- **Dispatch dedupe lock (not applicable — verified).** The original plan worried about `_recentActionDispatches` in `_handleTriggerAgentActionInternal` ([TaskViewerProvider.ts:15444-15470](../../src/services/TaskViewerProvider.ts#L15444-L15470)). The batch path **never touches** `_handleTriggerAgentActionInternal` — `handleKanbanBatchTrigger` calls `_dispatchExecuteMessage` directly ([TaskViewerProvider.ts:3369](../../src/services/TaskViewerProvider.ts#L3369)). The dedupe lock is irrelevant to this fix; no key collision is possible because the lock is not in the path at all.
- **Clipboard mutex (new).** `_clipboardLock` (terminalUtils.ts:5-11) already serializes all clipboard pastes, so concurrent dispatch is **safe** (no clipboard corruption, no cross-terminal paste bleed). The cost is that paste portions queue and do not overlap. This is the dominant bound on the speedup. No code change to the lock is required or recommended for this fix.
- **Failure isolation.** The current `try/catch` per bucket is preserved by `Promise.allSettled`; each bucket's rejection is captured independently and logged. One terminal failing does not abort the others.
- **Optimistic move + status toast.** `_distributePlannerDispatch` pre-moves cards and posts a summary toast *after* the loop ([KanbanProvider.ts:3406-3428](../../src/services/KanbanProvider.ts#L3406-L3428) pre-move; [3457-3464](../../src/services/KanbanProvider.ts#L3457-L3464) toast). With parallel dispatch, the toast fires after `allSettled` resolves; the optimistic move already happens up front so the board updates immediately regardless.
- **Terminal count vs live terminals.** `getRoleTerminalSet` returns only live terminals; if fewer are alive than the configured count, round-robin still works and parallelism is bounded by live terminals. No change needed.
- **Limit-dispatch toggle.** The "Limit dispatches to number of available terminals" option ([kanban.html:2698](../../src/webview/kanban.html#L2698)) caps plans to `terminals.length`; orthogonal to this fix.
- **Do not reduce the delays blindly.** The 1000 ms / 2000 ms values are there for CLI-agent correctness. The fix is overlap, not removal. (A separate, optional follow-up could make `clearDelay` configurable lower — it already is via `terminal.clearBeforePromptDelay` — but that's a user setting, not part of this fix.)
- **Other callers.** `_distributePlannerDispatch` is invoked from `moveSelected` ([KanbanProvider.ts:5617](../../src/services/KanbanProvider.ts#L5617), `skipLimit: true`) and `moveAll` ([KanbanProvider.ts:5716](../../src/services/KanbanProvider.ts#L5716)). Both flow through the same dispatch loop, so both benefit from the parallelization. No caller-side change required.

## Dependencies

- None. This plan is self-contained. It complements (but does not depend on) `feature_plan_20260624210141_kanban-advance-buttons-bounce-back.md`, which fixes the bounce-back by persisting the column move up front; landing both together gives the complete remedy, but each is independently valid.

## Adversarial Synthesis

Key risks: (1) the original plan oversells the speedup as "single-terminal time" when the global `_clipboardLock` (terminalUtils.ts:5-11) serializes the ~2000 ms/bucket paste portions, capping the real gain at ~2.5–3×; (2) the root-cause math misframes per-bucket cost as per-plan and misattributes the delay to `_executeLocal` (a different path) instead of `_attemptDirectTerminalPush` + `sendRobustText`; (3) stale line numbers would point the implementer at the wrong lines. Mitigations: the single `Promise.allSettled` change is correct and safe (the clipboard mutex already prevents corruption, and per-terminal `await` chains are isolated), expected timing is corrected to ~8–10 s for 4 terminals (from ~24 s), line numbers are corrected to 3443-3452, and no change to `sendRobustText`, the delays, or `_executeLocal` is required.

## Proposed Changes

### File 1: `src/services/KanbanProvider.ts`

**Parallelize the per-bucket dispatch in `_distributePlannerDispatch` ([KanbanProvider.ts:3443-3452](../../src/services/KanbanProvider.ts#L3443-L3452)).** Replace the sequential `for...await` with concurrent dispatch, one pipeline per terminal, joined by `allSettled`:

```js
// Dispatch buckets concurrently — distinct terminals are independent processes,
// so their per-send settle delays should overlap, not stack. Each bucket is ONE
// unified prompt for its terminal (handleKanbanBatchTrigger generates a single
// prompt per bucket), so there is no intra-bucket send loop to serialize.
// NOTE: clipboard-paste portions (~1s each for /clear and the prompt) are
// serialized by the global _clipboardLock in terminalUtils.ts, so the paste
// steps queue; the setTimeout settle delays (~4s/bucket) overlap. Net speedup
// is ~2.5-3x, NOT single-terminal time.
const bucketEntries = [...buckets.entries()];
const bucketResults = await Promise.allSettled(
    bucketEntries.map(([terminalName, ids]) =>
        vscode.commands.executeCommand(
            'switchboard.triggerBatchAgentFromKanban',
            'planner', ids, 'improve-plan', workspaceRoot, terminalName
        )
    )
);
bucketResults.forEach((r, i) => {
    if (r.status === 'rejected') {
        const terminalName = bucketEntries[i][0];
        console.error(`[KanbanProvider] Distribute dispatch to '${terminalName}' failed:`, r.reason);
    }
});
```

The optimistic pre-move and `moveCards` echo ([3406-3428](../../src/services/KanbanProvider.ts#L3406-L3428)) stay before this block, so the board updates instantly. The summary toast ([3457-3464](../../src/services/KanbanProvider.ts#L3457-L3464)) stays after, now firing once all terminals finish in parallel. The rotation-cursor advance ([3455](../../src/services/KanbanProvider.ts#L3455)) also stays after the `allSettled` await.

### File 2: `src/services/TaskViewerProvider.ts`

**No code change required — invariant verified.** The original plan suspected a within-terminal send loop might need guarding; confirmed there is none. `handleKanbanBatchTrigger` ([3299-3416](../../src/services/TaskViewerProvider.ts#L3299-L3416)) resolves one `targetAgent` per invocation ([3323-3324](../../src/services/TaskViewerProvider.ts#L3323-L3324)) and sends one unified prompt via a single `_dispatchExecuteMessage` ([3369](../../src/services/TaskViewerProvider.ts#L3369)) → `_attemptDirectTerminalPush` ([15354](../../src/services/TaskViewerProvider.ts#L15354)). The `/clear` → settle → prompt `await` chain ([15413-15429](../../src/services/TaskViewerProvider.ts#L15413-L15429)) is self-contained per invocation, so concurrency across invocations (from File 1) is inherently safe.

**Optional documentation comment** in `_attemptDirectTerminalPush` (near [15408](../../src/services/TaskViewerProvider.ts#L15408)), so a future refactor doesn't reintroduce a global send lock:

```js
// NOTE: handleKanbanBatchTrigger may now be invoked concurrently across
// distinct terminals (see _distributePlannerDispatch). The /clear + prompt
// await chain below is safe to run in parallel across terminals because each
// operates on its own vscode.Terminal. The clipboard pastes are serialized by
// _clipboardLock (terminalUtils.ts), which is intentional and prevents
// clipboard corruption — do NOT remove that lock.
```

**Optional micro-optimization (follow-up only, not core):** the trailing `await new Promise(r => setTimeout(r, 1000))` in `_executeLocal` ([14835/14841](../../src/services/TaskViewerProvider.ts#L14841)) is a flat 1s on a *different* path (not the batch path). If profiling of single-terminal *batch* dispatch shows the `NEWLINE_DELAY` (sendRobustText:71/119) dominates, it could be gated behind `paced`. Treat as a separate follow-up; do not bundle with this fix.

## Verification Plan

> Per session directives: **skip compilation** (`npm run compile` is not run) and **skip automated tests** (the suite is run separately by the user). Verification below is manual/behavioral.

### Automated Tests
- None run this session per session directives. The existing `src/test/review-comment-transport-regression.test.js` covers `sendRobustText` import shape and is unaffected by the KanbanProvider dispatch-loop change (different file/method). The user may run the suite separately.

**Step 1 — Reproduce the baseline.** Set planner Terminals = 4 in the Agents tab, ensure 4 live planner terminals exist, select ~8 plans in a planner-source column, and advance-all. Time the wall-clock from click to "Distributed N plan(s) across 4 planner terminal(s)" toast. With clear-before-prompt ON this should currently be on the order of **~24 s** (4 terminals × ~6 s/bucket, serialized).

**Step 2 — Apply File 1 and re-measure.** Same scenario. Expected: total time drops to **~8–10 s** (the ~4 s/bucket non-locked settle delays overlap; the ~2 s/bucket clipboard pastes queue on `_clipboardLock`). This is a **~2.5–3× improvement**, NOT single-terminal time — if you measure ~6 s, the prompts were likely short enough to skip clipboard paste (under 100 chars), which is uncommon for unified plan prompts. Confirm all 4 terminals receive their prompts and each prompt is intact (no `/clear` concatenation, no two prompts merged in one terminal, no clipboard bleed between terminals).

**Step 3 — Single-terminal integrity.** Set Terminals = 1, advance 3 plans. Confirm they arrive as one unified prompt, correctly cleared and submitted — i.e. the per-terminal `/clear`→settle→prompt pacing is unchanged.

**Step 4 — Failure isolation.** Close one of the 4 planner terminals mid-test (or point a bucket at a non-existent terminal). Confirm the other 3 still dispatch and the error is logged for the failed one only (no aborted batch) — `allSettled` captures each rejection independently.

**Step 5 — Optimistic board update.** Confirm the cards visually advance immediately on click (the pre-move at 3406-3428), independent of how long the terminal sends take — proving the board is no longer blocked on the serial dispatch.

**Step 6 — Clipboard integrity during concurrent dispatch.** With 4 terminals dispatching concurrently, copy some text to the clipboard yourself right before clicking advance-all, then check the clipboard afterward. Confirm your text is restored (the `_clipboardLock` save/restore in `pasteTextViaClipboard` should leave your clipboard intact once all pastes complete). This validates the mutex holds under the new concurrency.

**Step 7 — Build & install (user-run, separate session).** Build the extension, reload, and re-run Step 2 against the installed extension to confirm the timing improvement is real and not a `dist/` artifact. (Skipped this session per `SKIP COMPILATION`.)

---

**Recommendation:** Complexity 5/10 → **Send to Coder.** The change is a single localized concurrency refactor with a verified-safe invariant, but the timing-sensitive terminal-send context and the need to set realistic speedup expectations warrant a coder (not intern) implementer.

---

## Reviewer Pass (2026-06-25)

### Stage 1 — Grumpy Principal Engineer

Oh, you wrote a *performance* plan and then shipped a redundant terminal-enumeration call on the hot path. **Brilliant.** Let me count the ways this implementation found to undermine its own thesis.

**CRITICAL — none.** The core change is actually fine. Annoying.

**MAJOR — `_distributePlannerDispatch` calls `getRoleTerminalSet` TWICE per batch dispatch.** [KanbanProvider.ts:3411] fetches `{ terminals, locationKey }` for the limit check and no-terminals fallback. Then the implementer factored the cursor read+advance into a shiny new `_nextPlannerTerminals` helper [3385-3397] and called it at [3478] — which calls `getRoleTerminalSet` *again* internally [3388]. Each `getRoleTerminalSet` runs `_getAliveAutobanTerminalRegistry` ([TaskViewerProvider.ts:6080]), which does a `Promise.all` over PID resolution for **every** active terminal with a **1000 ms timeout each** ([6096-6100]). So your "make dispatch faster" plan added a second full round of PID resolution to every batch dispatch. The irony is thick enough to spread on toast. This is the kind of thing that happens when you refactor for "clean code" without checking what the helper actually costs.

**NIT — Cursor advance silently moved before the dispatch.** The plan explicitly says "The rotation-cursor advance also stays after the `allSettled` await." The implementation moved it *into* `_nextPlannerTerminals`, which is called *before* the `allSettled`. Functionally equivalent (the cursor value for this dispatch is read before bucketing either way; the advance only affects the *next* dispatch's start), but it deviates from the plan's stated ordering for no stated reason. Sloppy.

**NIT — Dead fallback branch.** `picked ? picked[i] : terminals[i % terminals.length]` — the null branch is unreachable. `tvp` is null-checked at [3406], `terminals.length === 0` returns early at [3412], and `_nextPlannerTerminals` only returns null when `tvp` is null or terminals is empty. So `picked` is never null here. Dead code masquerading as defensive programming. Remove it.

**Correct and matching plan (grudgingly acknowledged):** The `Promise.allSettled` parallelization itself is exactly right — failure isolation preserved via per-bucket rejection capture, optimistic pre-move and toast ordering unchanged, the optional documentation comment in `_attemptDirectTerminalPush` ([TaskViewerProvider.ts:15410-15415]) matches File 2. Fine.

**Out-of-scope changes bundled into the same commit (not this plan's criteria, noted for hygiene):** `targetTerminalOverride` plumbing in the single-dispatch paths (moveSelected [5060-5064], moveAll [5109-5113]) and the `moveCardToColumn` refactor replacing direct `db.updateColumn` ([6053-6075], [6075-6090]) are not in this plan's Proposed Changes. They appear to belong to the related bounce-back plan (`feature_plan_20260624210141`). They are internally consistent and well-formed, but they should not have been silently merged into this plan's commit. Separate concerns, separate commits.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Verdict |
|:---|:---|:---|
| Redundant `getRoleTerminalSet` call (double PID resolution per batch) | MAJOR | **Fix now** — inline the cursor read+advance using the already-fetched `terminals`/`locationKey`; eliminates the second enumeration call. |
| Cursor advance moved before dispatch (deviates from plan ordering) | NIT | **Fix now** (rides along with the MAJOR fix) — restore advance after `allSettled` await, matching the plan. |
| Dead fallback branch `picked ? ... : terminals[...]` | NIT | **Fix now** (rides along) — removed by inlining. |
| Out-of-scope `targetTerminalOverride` / `moveCardToColumn` changes in commit | NIT | **Defer** — not this plan's criteria; note for commit hygiene. The changes are consistent and correct. |

**Keep:** The `Promise.allSettled` core change, the rejection-capture logging, the optimistic pre-move, the toast ordering, the `_attemptDirectTerminalPush` documentation comment. All correct.

**Fix applied:** Replaced the `_nextPlannerTerminals(workspaceRoot, plans.length)` call in `_distributePlannerDispatch` with inlined cursor logic (`tvp.getPlannerRotationCursor(locationKey)` + `terminals[(cursor + i) % terminals.length]`), and moved `tvp.advancePlannerRotationCursor(locationKey, plans.length)` back to after the `allSettled` await. This removes the redundant `getRoleTerminalSet` call, restores the plan's stated cursor-advance ordering, and eliminates the dead fallback branch. `_nextPlannerTerminals` is retained — it is still used by the two single-dispatch paths ([5070], [5113]).

### Files Changed (Reviewer Pass)

- **`src/services/KanbanProvider.ts`** — `_distributePlannerDispatch` (~3474-3516): inlined cursor read+advance, removed redundant `getRoleTerminalSet` call, restored cursor advance after `allSettled`, removed dead fallback branch.

### Validation Results

- **Compilation:** Skipped per session directives (`SKIP COMPILATION`).
- **Automated tests:** Skipped per session directives (`SKIP TESTS`). The existing `src/test/review-comment-transport-regression.test.js` covers `sendRobustText` import shape and is unaffected by the KanbanProvider dispatch-loop change.
- **TypeScript sanity (manual):** `tvp.getPlannerRotationCursor(locationKey)` and `tvp.advancePlannerRotationCursor(locationKey, plans.length)` are the same calls the original (pre-implementation) code made; `terminals` and `locationKey` are in scope from [3411]; `cursor` is numeric. No new types introduced. The `_nextPlannerTerminals` helper is retained and still referenced at [5070] and [5113] — not orphaned.
- **Behavioral verification (Steps 1–6 in Verification Plan):** Not run this session (requires a live VS Code instance with planner terminals). The fix is structurally equivalent to the plan's proposed change plus the redundant-call elimination; the expected ~2.5–3× speedup bound (clipboard-mutex-limited) is unchanged.

### Remaining Risks

1. **Untested behavioral timing** — the ~8–10 s expectation for 4 terminals (Steps 1–2) is unverified this session; user must run it against an installed VSIX.
2. **Clipboard-integrity under concurrency (Step 6)** — unverified this session; the `_clipboardLock` save/restore in `pasteTextViaClipboard` is trusted to hold, but concurrent dispatch stress has not been exercised.
3. **Commit hygiene** — the `targetTerminalOverride` single-dispatch plumbing and `moveCardToColumn` refactor are bundled in the same commit but belong to the related bounce-back plan. Recommend the user separate them at commit time if still possible, or note the bundling in the bounce-back plan's review.
4. **`_nextPlannerTerminals` double-call in single-dispatch paths** — the two single-dispatch callers ([5070], [5113]) each call `_nextPlannerTerminals` which calls `getRoleTerminalSet`. These paths were not part of this plan and were not modified by the reviewer, but they carry the same redundant-enumeration cost if `getRoleTerminalSet` was already called earlier in their flow. Out of scope for this fix; noted for a future pass.
