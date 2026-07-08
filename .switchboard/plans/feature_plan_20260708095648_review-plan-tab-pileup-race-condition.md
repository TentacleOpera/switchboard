# Fix: Review Plan button opens duplicate Project panel tabs (race condition)

**Plan ID:** 9565a11f-50be-4ae8-bc47-88c80daddc43

## Goal

**Problem:** Clicking "Review plan" buttons on the Kanban board intermittently opens an entirely new `project.html` (PROJECT panel) tab instead of reusing the existing one, causing a pileup of duplicate tabs.

**Background:** The Kanban board's "Review plan" button sends a `reviewPlan` message to `KanbanProvider._handleMessage`. The handler checks whether a Project panel already exists via `hasProjectPanel()` and, if not, calls `openProject()` to create one. If one exists, it reveals it and forwards the plan selection.

**Root Cause:** A classic **check-then-act race condition** in the `onDidReceiveMessage` async callback. VS Code's `webview.onDidReceiveMessage` does NOT serialize concurrent async invocations — multiple messages can be in-flight simultaneously. When two `reviewPlan` messages arrive in quick succession (e.g., the user clicks review on two cards rapidly, or an automated dispatch fires multiple), both calls check `hasProjectPanel()` → `false` before either call to `openProject()` has assigned `this._projectPanel`. Both then proceed to `vscode.window.createWebviewPanel()`, creating two separate PROJECT tabs.

The race window is between:
1. `KanbanProvider` line 8396: `if (!this._planningPanelProvider.hasProjectPanel())`
2. `PlanningPanelProvider` line 347: `this._projectPanel = vscode.window.createWebviewPanel(...)`

The `await` on `openProject()` does not help because VS Code fires each `onDidReceiveMessage` callback independently — the second message's handler starts before the first's `await` resolves.

**Why it's hard to reproduce:** The race window is narrow — it requires two `reviewPlan` messages to overlap within the few milliseconds between the `hasProjectPanel()` check and the `createWebviewPanel()` assignment. Single deliberate clicks won't trigger it; it requires rapid successive clicks or automated flows.

### Root-Cause Reassessment (Review — read this before implementing)

> **Preserved above:** the original root-cause narrative is kept verbatim per the content-preservation rule. The findings below are a review-time correction and **must be reconciled before any code is written.**

A line-level trace of the current source undermines the "check-then-act race" mechanism as written:

1. **`openProject()` has no `await` in its own body before the panel is assigned.** `PlanningPanelProvider.openProject()` (lines 340-429) is declared `async`, but its only `await` (line 380) lives inside the *nested* `onDidReceiveMessage` callback, which runs later — not in `openProject`'s own control flow. The method's own statements execute **synchronously, top to bottom**: the `if (this._projectPanel)` check (line 342) and the `this._projectPanel = vscode.window.createWebviewPanel(...)` assignment (line 347) occur on the **same tick, with no yield in between**. `vscode.window.createWebviewPanel` is a synchronous API that returns a `WebviewPanel` immediately.

2. **Therefore the described race window does not open.** When `KanbanProvider` line 8380 runs `await this._planningPanelProvider.openProject()`, `openProject()` runs to completion — panel created, `_projectPanel` assigned — and *then* returns an already-resolved promise. The `await` yields **after** the panel exists. Because JavaScript is single-threaded, message B's handler cannot begin until message A's handler yields, and A yields only after the panel is built. A second concurrent `reviewPlan` will see `hasProjectPanel() === true` and take the reveal branch. Two `createWebviewPanel` calls cannot both observe `_projectPanel` falsy.

3. **There is exactly one `PlanningPanelProvider` instance.** `extension.ts` line 916 constructs a single `planningPanelProvider`, shared with `kanbanProvider` (line 937, `setPlanningPanelProvider`) and the `switchboard.openProjectPanel` command (line 973). So there is no second-instance explanation for duplicates either.

**Implication:** The proposed `_projectPanelOpening` promise lock serializes two calls that are *already* effectively serialized by the synchronous assignment. It is, at best, a **harmless defensive guard / future-proofing** (valuable only if a future refactor inserts an `await` before line 347) — not a fix for the reported symptom.

**If duplicate tabs are genuinely observed on the current build, the real cause is elsewhere. Credible alternative suspects to investigate (none of which the promise lock addresses):**
- **Restore / serializer ghost (research-confirmed as the documented real-world duplicate cause):** After `Developer: Reload Window`, VS Code recreates the tab wrapper from layout state but defers `deserializeWebviewPanel` — an asynchronous gap exists between extension activation and the serializer call. During that gap `_projectPanel` is `undefined`, so a `reviewPlan` click (or `activatePlanInProjectPanel`) creates a SECOND live panel beside the preserved/ghost tab. VS Code Issue #182795 ("Simple browser will be opened multiple times with race") is the documented precedent: duplicate tabs created during window reload because the tracking manager failed to safely handle deserialization timing. A second sub-mechanism is **lazy restoration**: a *hidden* (background) project tab is not deserialized until the user focuses it, so `_projectPanel` stays `undefined` even longer — any command or auto-start that checks `hasProjectPanel()` during that window spawns a duplicate active tab while the original background tab waits to deserialize. This is a restore/serializer bug, not a message race, and the `_projectPanelOpening` lock does not touch it. `deserializeProjectPanel` (line 658) sets `_projectPanel` synchronously at line 662 *before* awaiting `_hydratePanel`, so once the serializer runs the field is set — but the danger is the window *before* it runs.
- **Stale `_projectPanel` reference (research-confirmed failure cascade):** If `onDidDispose` was silently unregistered — which happens when a shared `_disposables` store is cleared (`.dispose()` on the store removes the listener subscription) — `_projectPanel` can point at a panel VS Code already destroyed. The documented cascade: (1) `_disposables` cleared, dispose listener removed; (2) panel stays open in editor layout; (3) user closes tab, webview destroyed; (4) clean-up callback never fires (subscription gone); (5) `_projectPanel` stays stale; (6) next `reveal()`/`postMessage()` throws `Webview is disposed`. The `_disposables` clear + re-registration dance at lines 9248-9266 exists precisely to defend against this. That produces a *zombie reveal* (no visible tab) — the opposite of a duplicate — but is a related class of reference-lifecycle bug worth auditing, and a correct fix would keep the panel's close listener on a dedicated self-clearing disposable separate from the general communication store.
- **`revealProject()` fire-and-forget:** `revealProject()` (line 817) does `void this.openProject()` — un-awaited. Still safe under the synchronous-assignment model, but worth noting as a non-awaited entry point.

**Action required before implementation:** Confirm the duplicate reproduces on the current build. If it does NOT, close this plan. If it DOES, prioritize the restore/serializer and stale-reference audits above the promise lock.

## Metadata

- **Tags:** bugfix, ui, reliability
- **Complexity:** 4

## User Review Required

**Yes — review required before implementation.** The review found that the plan's stated root-cause mechanism (a check-then-act race in `openProject`) is not achievable in the current code, because `openProject()` assigns `_projectPanel` synchronously with no preceding `await` in its own body (see *Root-Cause Reassessment*). Before implementing the proposed lock, the user must:
1. **Confirm reproduction** of the duplicate-tab symptom on the current installed build (rapid "Review plan" clicks, and a window-reload-with-retained-panel scenario).
2. **Decide scope:** if the symptom does not reproduce, close the plan. If it reproduces only after a window reload, the fix belongs in the `deserializeProjectPanel` / restore path, not in a creation lock.
3. **Approve shipping the lock as a defensive guard anyway** (harmless, future-proofs any later `await` insertion), with the understanding that it is not the fix for the reported bug.

## Complexity Audit

### Routine
- Logic change: add a promise-based lock (`_projectPanelOpening`) to `openProject()` — single class, single file.
- Risk of regression: Low — the lock is additive; the existing single-call and fast-path (`if (this._projectPanel) reveal`) behavior is unchanged.
- Migration needed: None — no persisted state or file-format changes.
- Clearing the lock on dispose: three `onDidDispose` sites need a one-line `this._projectPanelOpening = undefined;` addition.

### Complex / Risky
- **Diagnostic uncertainty (the real risk):** the plan's root cause is not confirmed against the current source. The change may be a no-op for the reported symptom. If duplicates stem from the restore/serializer or stale-reference path, this change will not resolve them and the bug will persist post-implementation — eroding trust in the fix.
- Future refactor hazard: the lock only earns its keep if `openProject()` later gains an `await` before the panel assignment; until then it guards a window that cannot open.

## Edge-Case & Dependency Audit

1. **Concurrent `openProject()` from multiple callers:** Not just `reviewPlan` — the `switchboard.openProjectPanel` command (`extension.ts:973`) and `revealProject()` fallback (`PlanningPanelProvider:817`, via `void this.openProject()`) also call `openProject()`. Any concurrent pair can race *in theory*. The fix belongs in `openProject()` itself, not in the `reviewPlan` handler. *(Review note: under the synchronous-assignment model these cannot actually overlap-then-duplicate; the lock is defensive.)*

2. **`activatePlanInProjectPanel` — a third caller the original audit missed.** `KanbanProvider.activatePlanInProjectPanel` (lines 241-249) has the same `if (!this._planningPanelProvider.hasProjectPanel()) { await this._planningPanelProvider.openProject(); } else if (isProjectInCurrentWindow()) { revealProject(); }` shape as the `reviewPlan` handler. It is reached from extension commands that activate a plan in the Project panel. Same analysis applies: protected by the lock, but cannot duplicate under the synchronous model.

3. **`deserializeProjectPanel` during window restore:** VS Code's serializer calls `deserializeProjectPanel` (line 658) which sets `this._projectPanel = panel` **synchronously at line 662** *before* awaiting `_hydratePanel`. So by the time hydration yields, the field is already set and a concurrent `reviewPlan` sees `hasProjectPanel() === true`. *(Review note: the original claim that "the deserialized assignment and `openProject()` creation are mutually exclusive via the same field" is imprecise — they share the field but `deserializeProjectPanel` does NOT consult `_projectPanelOpening`, so the lock does not gate it. This is benign under the sync model but is the most plausible source of a REAL duplicate if the serializer is delayed/fails and a ghost tab lingers with `_projectPanel` still unset.)*

4. **Panel disposed mid-race:** If `onDidDispose` fires (user closes the panel) between the `hasProjectPanel()` check and the `openProject()` guard, `_projectPanel` is set to `undefined`. The lock's resolved panel would be stale. The `openProject()` internal `if (this._projectPanel)` check after awaiting the lock handles this — if the panel was disposed, the field is `undefined` and a new one is created.

5. **`revealProject()` calling `openProject()`:** `revealProject()` checks `if (this._projectPanel)` first, then calls `openProject()` as a fire-and-forget (`void this.openProject()`, line 821). This is also a check-then-act but less likely to race since it's typically called from the extension host, not rapid webview messages. The lock still protects it.

6. **Planning panel `open()` has the same pattern:** `open()` (lines 531-545) has the same `if (this._panel) { reveal; return; }` then `createWebviewPanel` structure, also synchronous up to assignment. The same (non-)race exists there but is less likely to be triggered by rapid user actions. This plan focuses on `openProject()` but the same guard pattern could be applied to `open()` as a follow-up for symmetry.

## Dependencies

- None.

## Uncertain Assumptions

The review is **highly confident** in the local code facts (single `PlanningPanelProvider` instance; `openProject()` body is synchronous up to the `_projectPanel` assignment at line 347; the sole `await` at line 380 is inside a nested callback). The VS Code platform behaviors the review relied on were **confirmed via web research** (see *Research Confirmation* below); the only residual uncertainty is empirical.

- **VS Code webview message-dispatch concurrency model — CONFIRMED by research.** `vscode.window.createWebviewPanel` is strictly synchronous (returns a `WebviewPanel` immediately, not a Thenable). `onDidReceiveMessage` is backed by a synchronous `EventEmitter`; an `async` listener runs its synchronous portion to the first `await`, yields, and the next message dispatches as a *separate macrotask* — the listener is **never re-entered synchronously**. Therefore a check + synchronous `createWebviewPanel` assignment in one unbroken synchronous block is physically uninterruptible. The research further confirms a check-then-act race **is** achievable *only* if an `await` is inserted between the check and the assignment — exactly the "future-proofing" framing this plan adopts for the lock.
- **Empirical reproducibility of the reported duplicate-tab symptom** on the current build cannot be established from source alone — it requires running the extension. See *User Review Required*.

### Research Confirmation

Web research was run against the official VS Code Extension API docs, the `microsoft/vscode` repository issues/source, and the JavaScript single-threaded event-loop model. It confirmed all platform-behavior assumptions above and — critically — validated the **restore/serializer ghost** as the documented real-world cause of duplicate webview tabs (VS Code Issue #182795, "Simple browser will be opened multiple times with race": duplicate tabs created during window reload because the tracking manager failed to safely handle deserialization timing). The research also documented the **silent `onDidDispose` unregistration** failure cascade (disposing a `_disposables` store removes the dispose listener, leaving a stale `_panel` reference that throws `Webview is disposed` on later access) — confirming the audit's stale-reference concern. These findings are folded into the *Root-Cause Reassessment* alternative-suspects list below.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the plan's stated root-cause race is not achievable in the current code — `openProject()` assigns `_projectPanel` synchronously before any yield, so the promise lock is a no-op for the reported symptom; (2) if duplicate tabs are real, the likely cause is a restore/serializer ghost or stale `_projectPanel` reference, neither touched by this lock; (3) the original audit missed a third caller (`activatePlanInProjectPanel`) and a third `onDidDispose` site. Mitigations: preserve the lock as a harmless defensive guard, correct the root-cause narrative, add the missing caller/dispose-site to the change set, and gate implementation on confirmed reproduction plus a restore-path audit.

## Proposed Changes

### File: `src/services/PlanningPanelProvider.ts`

> **Review reframing:** The changes below are preserved from the original plan. Treat Change 1/2 as a **defensive guard + future-proofing**, not as the fix for the reported duplicate-tab symptom (see *Root-Cause Reassessment*). Line numbers corrected to current source: the `reviewPlan` handler is at `KanbanProvider` lines 8372-8402 (check at 8379, `await openProject()` at 8380), not 8389-8418.

**Change 1: Add a pending-creation promise to serialize concurrent `openProject()` calls**

Add a private field to track an in-flight `openProject()` promise. Concurrent callers await the same promise instead of each creating a panel.

```typescript
// Add near other private fields (around line 73-77)
private _projectPanelOpening: Promise<void> | undefined;
```

**Change 2: Guard `openProject()` with the promise**

Replace the current `openProject()` method (lines 340-428) with a version that uses the promise lock:

```typescript
public async openProject(): Promise<void> {
    // If a creation is already in-flight, await it instead of racing.
    if (this._projectPanelOpening) {
        await this._projectPanelOpening;
        // After awaiting, the panel may have been disposed already.
        // Re-check and reveal if it still exists.
        if (this._projectPanel) {
            this._projectPanel.reveal(vscode.ViewColumn.One);
        }
        return;
    }
    // If the panel already exists, reveal it (fast path — no lock needed).
    if (this._projectPanel) {
        this._projectPanel.reveal(vscode.ViewColumn.One);
        return;
    }
    // Create the lock promise, then do the actual creation.
    this._projectPanelOpening = this._doOpenProject();
    try {
        await this._projectPanelOpening;
    } finally {
        this._projectPanelOpening = undefined;
    }
}

private async _doOpenProject(): Promise<void> {
    this._lastWebviewRootsSignature = '';
    // Double-check after entering the lock — a concurrent caller may have
    // already created the panel.
    if (this._projectPanel) {
        this._projectPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    this._projectPanel = vscode.window.createWebviewPanel(
        'switchboard-project',
        'PROJECT',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );
    // ... rest of the existing openProject() body (lines 356-428) unchanged ...
    // (ready handshake, pending messages, timer, icon, html, message handler,
    //  dispose handler, config listener, theme posts, auto-fetch state)
}
```

**Change 3: Clear the lock on dispose — ALL THREE `onDidDispose` sites**

In every `onDidDispose` handler that nulls `_projectPanel`, add the lock clear so a future `openProject()` can create a fresh panel after disposal. The original plan listed two sites; a review found a **third** (the `dispose()` re-registration path):

```typescript
this._projectPanelOpening = undefined;
```

The three sites are:
1. **`openProject` / `_doOpenProject` onDidDispose** (~line 390-404) — the handler registered at panel creation.
2. **`_hydratePanel(isProject=true)` onDidDispose** (~line 706-716) — the handler registered during window-restore deserialization.
3. **`dispose()` re-registered onDidDispose** (~line 9257-9266) — when the *Planning* panel is closed first, `_disposables` is cleared (which disposes the original project-panel listeners), so `dispose()` re-binds a fresh `onDidDispose` for the still-open project panel. **This site was missing from the original plan and must also clear the lock**, or the lock-clear invariant has a hole if disposal happens via this path.

This ensures that if the panel is disposed while a caller is awaiting the lock, the lock is cleared so a future `openProject()` can create a fresh panel.

### File: `src/services/KanbanProvider.ts`

**No changes needed.** The `reviewPlan` handler (lines 8372-8402) is correct in its logic — it checks `hasProjectPanel()` (line 8379), calls `openProject()` (line 8380), then sends the selection message (line 8390). The same-shape `activatePlanInProjectPanel` caller (lines 241-249) is likewise correct. The fix is entirely in `openProject()` serialization.

## Verification Plan

> **Session directives:** Per this session, **skip compilation** (`npm run compile`) and **skip running automated tests**. The steps below describe what to verify; the user runs them when ready.

### Automated Tests

- **Pragmatic unit test (matches the suite's idiom):** The existing `src/test/project-panel-kanban-create-button.test.js` uses **static-source-assertion** (read the `.ts` as a string, assert `includes(...)`), not a mocked `vscode` namespace. The originally-proposed "mock VS Code API + sinon-spy on `createWebviewPanel`, call `openProject()` twice concurrently" test is **out of reach** for this suite's style — it would require mocking the entire `vscode` module and constructing a `PlanningPanelProvider` whose constructor demands an `ExtensionContext`, `PanelStateStore`, adapter factories, and a workspace-root getter. That is a scaffolding project, not a routine test. Additionally, since the race does not occur in the current code, even a perfect mock would show `createWebviewPanel` called once **with or without** the lock — proving nothing about behavior.
  - **Recommended instead:** a static-source-assertion test asserting the guard's *presence*: `PlanningPanelProvider.ts` includes `_projectPanelOpening`, `await this._projectPanelOpening`, and `_doOpenProject`, and that all three `onDidDispose` sites that set `this._projectPanel = undefined` are followed by `this._projectPanelOpening = undefined`. This verifies the invariant mechanically without a runtime mock.

### Manual Verification

1. **Repro attempt (the real signal):** Open the Kanban panel. Rapidly click "Review plan" on 3+ different cards in quick succession. Verify only ONE PROJECT panel tab opens, with the last-clicked plan selected. **Expected per the reassessment: only one tab opens even WITHOUT the fix** — if you still see duplicates, the cause is not this race; capture the exact scenario (especially whether a window reload / "Restore Editors" was involved) and pivot to the restore/serializer audit.

2. **Restore/serializer scenario (priority if duplicates are real):** With a Project panel open and `retainContextWhenHidden: true`, reload the VS Code window (`Developer: Reload Window`). Before interacting with anything, immediately click "Review plan" on a Kanban card. If a SECOND Project tab appears beside the restored one, the real cause is the `deserializeProjectPanel` / restore path — file that as the primary fix target.

3. **Regression check:** Open the Project panel via the command palette (`switchboard.openProjectPanel`), then click "Review plan" on a Kanban card. Verify the existing panel is revealed (not a new one created). This confirms the fast-path `if (this._projectPanel)` still works.

4. **Dispose-then-reopen:** Open the Project panel, close it, then click "Review plan". Verify a single new panel opens (the lock was cleared on dispose).

5. **`activatePlanInProjectPanel` path:** Trigger a plan activation that routes through `KanbanProvider.activatePlanInProjectPanel` (lines 241-249). Verify it reveals/creates a single Project panel, same as `reviewPlan`.

---

**Recommendation:** Complexity 4 → **Send to Coder** — but only after the *User Review Required* reproduction check passes. Treat the lock as a defensive guard; if reproduction points to the restore/serializer or stale-reference path, re-scope this plan before coding.
