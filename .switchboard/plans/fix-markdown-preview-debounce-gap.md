# Fix Markdown Preview Debounce Gap

## Goal
Eliminate spurious markdown preview re-renders in planning.html by re-checking the panel-write guard *inside* the active document watcher's debounced callback, closing a timing window where a write that lands during the 300ms debounce triggers an unwanted re-render.

### Problem Analysis

The previous plan (`fix-markdown-preview-spurious-rerender.md`) fixed the file watcher configuration (ignoring create events) and added backend content deduplication to `_handleFetchDocsFile`. However, the preview still re-renders because of a **debounce gap**.

In `_setupActiveDocWatcher` (`src/services/PlanningPanelProvider.ts:820-852`):

```typescript
this._activeDocWatcher.onDidChange(() => {
    if (gen !== this._watcherGeneration) { return; }                     // stale watcher
    if (Date.now() - this._lastPanelWriteTimestamp < 1000) { return; }   // ← checked here (line 822)
    if (filePath !== this._activePreviewPath) { return; }                // stale path

    if (this._activeDocWatchDebounce) {
        clearTimeout(this._activeDocWatchDebounce);
    }

    this._activeDocWatchDebounce = setTimeout(async () => {
        if (gen !== this._watcherGeneration || filePath !== this._activePreviewPath) { return; }
        // ← _lastPanelWriteTimestamp NOT re-checked here after the 300ms delay
        await this._handleFetchPreview(...) / _handleFetchKanbanPlanPreview(...) / _handleFetchDocsFile(...);
    }, 300);
});
```

The `_lastPanelWriteTimestamp` guard is checked **before** the 300ms debounce starts. If a panel-initiated write to the file happens during that 300ms window (cache refresh, sync service write-back, another panel operation), the debounced callback fires, reads the freshly-written on-disk content, and — if that content differs from the cached `_lastPreviewContentByPath` value — posts a `previewReady` message and triggers a full re-render.

This is not a theoretical edge case — background writes to `.switchboard/docs/` and `.switchboard/plans/` files happen continuously from:
- `GlobalPlanWatcherService` updating plan metadata
- `ClickUpSyncService` writing imported stubs
- `ContinuousSyncService` writing plan content back to disk
- Cache refresh operations writing frontmatter-stamped copies (`_refreshCacheInBackground`, `PlanningPanelProvider.ts:5184-5186`, which stamps `_lastPanelWriteTimestamp` only at write time)

### Root Cause
The `_lastPanelWriteTimestamp` guard is not re-checked inside the debounced callback. After the 300ms delay elapses, the callback proceeds (aside from stale-watcher / stale-path checks at line 830), even if a panel-initiated write happened during the debounce period.

**Clarification (existing mitigation, not new scope):** A content-dedup guard already exists in all three auto-refresh paths — `_handleFetchKanbanPlanPreview` (`899-903`), `_handleFetchPreview` local-folder (`5006-5023`), and `_handleFetchDocsFile` (`5417-5421`). Each skips the `previewReady` post when `requestId === -1` and the new content equals the cached `_lastPreviewContentByPath` value. So *identical* background writes already cause no re-render. The debounce-gap fix is therefore a complementary guard that matters specifically when the on-disk content **differs** at the moment the debounce fires (e.g. the panel's own write is what changed it).

## Metadata
**Tags:** bugfix, UI, backend
**Complexity:** 2

## User Review Required
No

## Complexity Audit

### Routine
- Add a single `_lastPanelWriteTimestamp` guard inside the watcher's debounced `setTimeout` callback, after the existing stale-watcher / stale-path checks (`PlanningPanelProvider.ts:830`). This one guard covers all three dispatch branches (`_handleFetchPreview`, `_handleFetchKanbanPlanPreview`, `_handleFetchDocsFile`) because they all run inside the same callback.

### Complex / Risky
- None. This is a single-line defensive check inside an existing callback, with no behavior change for legitimate external updates that arrive more than ~1s after any panel write.

## Edge-Case & Dependency Audit

- **Race Conditions:** This fix *closes* a race, not introduces one. If an external change and a panel write both land in the same 300ms debounce window, skipping the refresh is correct — the panel write already pushed the current content to the webview. The guard mirrors the pre-debounce check at line 822, so the read of `_lastPanelWriteTimestamp` is consistent with existing logic (single-threaded VS Code extension host; no atomicity concern).
- **Security:** None.
- **Side Effects:** Legitimate external updates that arrive >1000ms after any panel write still trigger refresh normally. The only behavioral narrowing is the false-negative window described under Remaining Risks.
- **Dependencies & Conflicts:** None. Self-contained within `_setupActiveDocWatcher`. Note an existing inconsistency (not in scope to change): the visibility/refresh guard at line 614 uses a `< 2000` threshold while the watcher guards use `< 1000`. The new guard should match the watcher's `< 1000` for internal consistency.

## Dependencies
none

## Adversarial Synthesis

Key risks: (1) the guard widens an existing false-negative window — any one-shot legitimate external edit landing within ~1000ms of a panel write is silently dropped until the file changes again; (2) the original plan's proposed "second change" to `_handleFetchDocsFile` is redundant and could cause confusion. Mitigations: the false-negative window is already accepted behavior from the pre-debounce guard at line 822 and is bounded at 1s; ship only the single guard inside the watcher callback (one guard covers all three fetch branches) and explicitly drop the redundant second change.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

#### Context
`_setupActiveDocWatcher` (`789-874`) creates a `FileSystemWatcher` and debounces `onDidChange` events. The pre-debounce `_lastPanelWriteTimestamp` check at line 822 does not protect against panel writes that happen *during* the 300ms debounce window. The debounced `setTimeout` (`829-852`) dispatches to one of three fetch helpers depending on `_activePreviewSourceId`.

#### Logic
Re-evaluate the panel-write guard at the moment the debounce actually fires, not just when it is scheduled. Because the guard sits at the top of the shared `setTimeout` callback, it protects every dispatch branch with one check.

#### Implementation

**Primary change — line 830 (inside the `setTimeout` callback):** Add a `_lastPanelWriteTimestamp` guard immediately after the existing stale-watcher / stale-path check:

```typescript
this._activeDocWatchDebounce = setTimeout(async () => {
    if (gen !== this._watcherGeneration || filePath !== this._activePreviewPath) { return; }
    if (Date.now() - this._lastPanelWriteTimestamp < 1000) { return; } // ← ADD: skip if a panel write landed during the debounce window

    const workspaceRoot = this._activePreviewWorkspaceRoot
        || this._getWorkspaceRoot()
        || (this._getWorkspaceRoots().length > 0 ? this._getWorkspaceRoots()[0] : undefined);
    if (!workspaceRoot) return;
    // ... existing dispatch to _handleFetchPreview / _handleFetchKanbanPlanPreview / _handleFetchDocsFile unchanged
}, 300);
```

> **Original plan note (preserved):** The original plan also proposed adding the same check to the `_handleFetchDocsFile` auto-refresh path (its "Lines 838-846" item).
>
> **Clarification (correction):** This second change is **not needed and should not be made**. `_handleFetchDocsFile` has no debounce of its own — it is invoked *from* the watcher's `setTimeout` (line 847). The single guard above already protects it, along with the other two branches. Adding a guard inside `_handleFetchDocsFile` would also wrongly block legitimate user-initiated fetches (`requestId >= 0`) that follow shortly after a panel write.

#### Edge Cases
- **Panel write during debounce:** lastPanelWriteTimestamp is recent → callback returns early → no re-render. ✅ (the fix)
- **Genuine external change, no recent panel write:** diff ≥ 1000ms → callback proceeds → refresh fires normally. ✅
- **Identical external content:** already handled upstream by the `_lastPreviewContentByPath` dedup in each fetch helper — no `previewReady` posted even if the guard passes. ✅
- **Stale watcher / path switch during debounce:** existing `gen`/`filePath` checks at line 830 still fire first. ✅
- **File deleted during debounce:** handled by the separate `onDidDelete` handler (`855-868`), which clears the debounce. ✅

## Verification Plan

### Automated Tests
Add unit coverage around `_setupActiveDocWatcher`'s debounced callback (jest, with `setTimeout`/`Date.now` faked):
1. **Drops refresh on in-window panel write:** schedule the debounce, advance fake time, set `_lastPanelWriteTimestamp = Date.now()` *before* the timer fires, run the timer → assert none of `_handleFetchPreview` / `_handleFetchKanbanPlanPreview` / `_handleFetchDocsFile` is invoked.
2. **Allows refresh after the window:** set `_lastPanelWriteTimestamp` to >1000ms in the past, fire the timer → assert the correct dispatch helper is called once.
3. **Branch coverage:** parametrize `_activePreviewSourceId` over `local-folder` / `html-folder`, `kanban-plan`, and the imported-doc default to confirm the single guard short-circuits all three branches.
4. **Stale-guard precedence:** bump `_watcherGeneration` (or change `_activePreviewPath`) before firing → assert early return regardless of timestamp.

Run with `--forceExit` per the project jest workflow. (Per session directive, tests and compilation are executed separately by the user, not as part of this plan run.)

### Manual Validation
1. Open a markdown file in planning.html and observe the preview.
2. Trigger a background write to the same file (e.g. via sync, cache refresh, or a panel-initiated save).
3. Confirm the preview does **not** re-render if the write happens within ~300ms of a previous panel write.
4. Confirm the preview **does** re-render if the file is modified externally with no panel write in the last second.

## Remaining Risks
- **False-negative window (accepted):** Any legitimate one-shot external edit that lands within ~1000ms of a panel write is silently skipped and will not surface until the file changes again. This is identical to the behavior of the existing pre-debounce guard at line 822 and is bounded at 1s; not a regression.
- **Continuous external rewrites:** If the underlying file is being modified continuously by an external process (e.g. a build step writing to the same path), the preview may still update frequently once writes fall outside the 1s window. This is correct behavior — the file is actually changing.

---
**Recommendation:** Complexity 2 (≤ 6) → **Send to Coder**.

---

## Reviewer Pass (2026-06-19)

### Stage 1 — Grumpy Principal Engineer

> *Cracks knuckles. Pulls up the diff with the weary suspicion of someone who has been burned by "one-line defensive checks" before.*
>
> **A "debounce gap" fix. Adorable. Let's see if you actually closed the gap or just drew a chalk outline around it.**
>
> Line 898. There it is. `if (Date.now() - this._lastPanelWriteTimestamp < 1000) { return; }`, sitting *inside* the `setTimeout`, *after* the stale-watcher/stale-path check at 897. Fine. **It's in the right place** — the guard re-reads the timestamp at the moment the timer fires, not when it was scheduled. The whole point of this plan. You didn't put it before the `gen`/`filePath` check (which would waste a comparison on a dead watcher), and you didn't bury it after the `workspaceRoot` resolution (which would do pointless work before bailing). I came here to scream and instead I'm... grudgingly nodding. **NIT at most.**
>
> **Now the trap.** The original plan wanted a *second* guard shoved into `_handleFetchDocsFile`. I went looking for that landmine — line 5745 onward. And it is **not there.** Only the content-dedup at 5827. Good. Whoever implemented this read the correction and did NOT bolt a `_lastPanelWriteTimestamp` check onto a helper that also serves *user-initiated* fetches (`requestId >= 0`). Adding it there would have silently eaten legitimate clicks for a full second after every panel write. The dog that didn't bark. **Correct restraint — no finding.**
>
> **The threshold.** Watcher guards both say `< 1000`. The visibility guard at line 619 says `< 2000`. Inconsistent? Yes. *In scope?* No — the plan explicitly fenced that off, and the new guard correctly mirrors its *sibling* at line 889, not the distant cousin at 619. I'll allow it. **NIT, documented, deferred.**
>
> **The thing nobody wrote down.** That `_isAutoRefreshing = true` at 906 / `false` in the `finally` at 918 — this isn't in the plan. *Where did it come from?* I sniffed around: it's a pre-existing companion flag feeding `isAutoRefreshed` into every `previewReady` post (982, 5439, 5495, 5838...). Not this plan's child. It's set and cleared synchronously around the single awaited dispatch, with a `finally` so it can't get stuck `true`. Not a leak, not a regression, not my problem today. **No finding — but I'm noting it so the next reviewer doesn't waste twenty minutes like I did.**
>
> **Verdict:** I wanted blood. I got a clean, minimal, correctly-placed guard and a correctly-*omitted* second guard. Infuriating. Ship it.

### Stage 2 — Balanced Synthesis

**Keep (no change):**
- The single in-debounce guard at `PlanningPanelProvider.ts:898`. Placement is optimal: after the stale `gen`/`filePath` short-circuit (897), before `workspaceRoot` resolution (900) and the dispatch. One guard covers all three branches (`_handleFetchPreview`, `_handleFetchKanbanPlanPreview`, `_handleFetchDocsFile`) exactly as designed.
- The deliberate **omission** of the redundant `_handleFetchDocsFile` guard. Verified absent (5745–5839 has only the content-dedup at 5827). This is the plan's explicit correction, correctly honored.
- The three pre-existing content-dedup guards (kanban 968, local-folder/docs 5827, fetchPreview 5827/5439) remain intact and continue to suppress identical-content re-renders.

**Fix now:** Nothing. No CRITICAL or MAJOR findings. The implementation is faithful to the plan with no scope creep attributable to this change.

**Defer (NIT, out of scope per plan):**
- Threshold inconsistency: watcher guards use `< 1000` (889, 898), visibility/refresh guard uses `< 2000` (619). The plan explicitly scoped this out; the new guard correctly matches its sibling. No action.
- `_isAutoRefreshing` (906/918) is a pre-existing mechanism, not introduced here; no action.

### Code Fixes Applied
None — no valid CRITICAL/MAJOR findings.

### Files Changed (by the implementation, this plan)
- `src/services/PlanningPanelProvider.ts:898` — added in-debounce `_lastPanelWriteTimestamp < 1000` guard inside the active-doc-watcher `setTimeout` callback.

### Validation Results
- Per session directives: **compilation skipped** and **automated tests skipped** (run separately by the user). The automated-test plan above (drops-on-in-window-write, allows-after-window, branch coverage, stale-guard precedence) remains the recommended coverage.
- Static review confirms: guard present and correctly placed (898); redundant `_handleFetchDocsFile` guard correctly absent; all three dedup guards intact; no working-tree diff outstanding.

### Remaining Risks
- Unchanged from the plan's **Remaining Risks** section: the 1s false-negative window (a one-shot legitimate external edit within ~1000ms of a panel write is skipped until the next change) is accepted, bounded, and identical to the pre-debounce guard's behavior. Continuous external rewrites correctly continue to refresh once writes fall outside the 1s window.
