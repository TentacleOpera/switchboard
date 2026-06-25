# Memo Status-Bar Link Lands on Terminals Tab on Cold Sidebar Open

## Goal

Make the **Memo** status-bar item (and the other entry points routed through `switchboard.openMemo`) reliably open the sidebar on the **Memo** sub-tab — including the case where the Switchboard sidebar (`implementation.html`) has **not been opened once since VS Code started**.

### Problem analysis

When the user clicks the Memo status-bar item before the sidebar webview has ever been resolved in the current VS Code session, the sidebar opens on the **Terminals** sub-tab instead of **Memo**. The "default to Terminals" sub-tab behaviour wins, even though the user explicitly asked for Memo. When the sidebar has already been opened once (warm path), the Memo link works — `this._view` is live and the `openMemoTab` IPC message switches the tab immediately.

### Root cause

The command path is:

`switchboard.openMemo` (`src/extension.ts:795`) → `TaskViewerProvider.openMemoTab()` (`src/services/TaskViewerProvider.ts:2649`).

`openMemoTab()` does three things:

1. `await workspaceState.update(ACTIVE_SUB_TAB_STATE_KEY, 'memo')` — persists the intent so a *cold* open can restore to Memo via `_sendInitialState`.
2. `await executeCommand('switchboard-view.focus')` — reveals/resolves the view.
3. `this._view?.webview.postMessage({ type: 'openMemoTab' })` — switches the tab on a warm view.

On a **cold** open, step 3's message is posted before the webview's JS has mounted its `message` listener, so it is dropped. The design intends the **persisted** `'memo'` value (step 1) to be the reliable fallback: `_sendInitialState` reads `ACTIVE_SUB_TAB_STATE_KEY` (`TaskViewerProvider.ts:5402`) and sends `activeSubTab: 'memo'` in the `initialState` message, and the webview restores it (`implementation.html:2181-2182`).

That fallback is defeated by a **clobber feedback loop** in the webview:

- The webview initialises `currentAgentTab = 'terminals'` (`implementation.html:2581`).
- `switchAgentTab(tab)` **unconditionally** posts `{ type: 'setActiveSubTab', tab }` back to the host (`implementation.html:2587`), and the host persists whatever it receives (`TaskViewerProvider.ts:9455-9459`).
- `renderAgentList()` ends by calling `switchAgentTab(currentAgentTab)` to re-apply tab visibility after a re-render (`implementation.html:2963` and `:3081`).
- On cold boot, a `terminalStatuses` refresh fires during `resolveWebviewView`'s Phase-1 init (`TaskViewerProvider.ts:8319-8323`) and the `'ready'` handler (`:8385-8389`). If `renderAgentList()` runs while `currentAgentTab` is still the `'terminals'` default — i.e. before/around the `initialState` message is processed — it posts `setActiveSubTab: 'terminals'`, which **overwrites the persisted `'memo'`** that `openMemoTab()` wrote in step 1.

So the very fallback that is supposed to carry the Memo intent across a cold open is silently clobbered by the default `'terminals'` sub-tab echoing itself back through `setActiveSubTab` during the first render. The net effect the user observes: "the default-to-terminals behaviour forces the tab away from Memo."

### Fix summary

Stop programmatic / re-render tab applies from persisting state. Only a **genuine user tab click** should write `setActiveSubTab`. This removes the clobber loop so the persisted `'memo'` survives until `_sendInitialState` reads it, making the cold-open Memo link reliable. The warm path is unchanged.

**Codebase precedent:** The main-tab helper `setActiveTab(tab, persist = true)` (`implementation.html:2007-2014`) already uses this exact guard pattern — `if (persist) { vscode.postMessage({ type: 'setActiveTab', ... }) }`. The sub-tab helper `switchAgentTab` simply never received the same treatment. This fix mirrors the proven, existing pattern in the same file — it is not a new architectural pattern.

## Metadata

- **Tags:** `bugfix`, `ui`, `ux`, `frontend`
- **Complexity:** 3 / 10
- **Primary files:** `src/webview/implementation.html`, `src/services/TaskViewerProvider.ts`
- **User-facing:** Yes (status-bar Memo button behaviour)
- **Migration impact:** None (in-memory/workspaceState tab selection only; no shipped on-disk schema changes)

## User Review Required

Yes — this changes sub-tab persistence semantics for the sidebar. While the fix is narrowly scoped (programmatic applies no longer persist), a reviewer should confirm that no downstream feature relies on `renderAgentList()` re-applies writing `setActiveSubTab` back to the host. The edge-case audit below covers the known paths, but a quick sanity check of any custom integrations is advisable before merging.

## Complexity Audit

### Routine

- Adding a `persist = true` parameter to `switchAgentTab` and guarding the `setActiveSubTab` post — mirrors the existing `setActiveTab(tab, persist = true)` pattern at line 2007.
- Passing `false` from the two `renderAgentList()` re-apply call sites (lines 2963, 3081) and the `initialState` restore (line 2182).
- Leaving the user-click binding (line 2639) and the `openMemoTab` IPC handler (line 2203) on default `persist = true`.
- Optional `setTimeout` re-post in `openMemoTab()` — additive, idempotent, 4 lines.

### Complex / Risky

- The cold-boot message-ordering race between `initialState`, `terminalStatuses` refresh, and the `'ready'` handler. The fix must be correct regardless of which message arrives first. The persist-flag approach (rather than timing guards) is what makes this robust — removing the side-effect eliminates the race entirely instead of trying to win it.

## Edge-Case & Dependency Audit

- **Race Conditions:** The core bug IS a race — `renderAgentList()` re-applies `switchAgentTab('terminals')` during cold boot, which persists and clobbers the `'memo'` intent before `initialState` can restore it. The fix removes the persist side-effect from programmatic applies, so the race becomes harmless: regardless of whether `renderAgentList()` runs before or after `initialState`, no spurious `setActiveSubTab` is posted. The persisted `'memo'` survives in all orderings.
- **Security:** No security implications — tab selection is a UI preference stored in `workspaceState`, not secrets or auth state.
- **Side Effects:**
  - `memoLoad` is only posted when `isChanging` is true (`implementation.html:2596`). On the cold path: `initialState` restore fires `switchAgentTab('memo', false)` with `isChanging=true` → `memoLoad` fires once. The optional safety-net `openMemoTab` IPC 300ms later fires `switchAgentTab('memo')` with `isChanging=false` → `memoLoad` does NOT re-fire. No double-load.
  - The `terminals` tab's `getStartupCommands`/`getVisibleAgents`/etc. posts (lines 2599-2610) fire whenever `switchAgentTab('terminals')` is called, including programmatic re-applies. With the fix, these still fire (only the `setActiveSubTab` post is guarded by `persist`). This is unchanged behaviour — the plan only guards the persist post, not the data-fetch posts. No regression.
  - Minor inconsistency: the `openMemoTab` IPC handler at line 2203 keeps default `persist=true`, so the cold-path safety-net re-assert writes `setActiveSubTab: 'memo'` back to the host. This is a redundant write of the same value — harmless, but technically a programmatic apply persisting. Not worth changing because it writes the identical value the host already holds.
- **Dependencies & Conflicts:** No dependency on other plans or sessions. No conflicts with in-flight work — the change is localized to `switchAgentTab` and `openMemoTab`.
- **Warm open (sidebar already resolved):** `openMemoTab()` step 3's `openMemoTab` IPC still fires and switches to Memo immediately. The fix does not touch that path. ✔
- **Cold open via Memo status bar:** persisted `'memo'` now survives → `initialState` carries `activeSubTab: 'memo'` → webview restores Memo. ✔
- **User clicks Terminals/Agents/Memo tab manually:** still persists via `setActiveSubTab` (persist path retained for real clicks). ✔
- **Re-renders while on Terminals/Agents:** `renderAgentList()` re-applies visibility without persisting — no behaviour change for the user, because the host already holds the correct value from the last genuine click or from `initialState`. ✔
- **`initialState` restore itself:** restoring `restoredSubTab` uses the no-persist path — the host is the source of that value, so echoing it back would be redundant and risks re-introducing a clobber. ✔
- **Invalid/unknown sub-tab values:** host already clamps to `['agents','terminals','memo']` with a `'terminals'` fallback (`TaskViewerProvider.ts:9457`); webview clamps similarly (`implementation.html:2180-2181`). Unchanged. ✔
- **Other `openMemo` entry points:** the status-bar item (`extension.ts:1900-1905`), hub tooltip link (`extension.ts:2050`), and panel button (`extension.ts:2187`) all route through `switchboard.openMemo`, so they inherit the fix. ✔
- **No dependency on `dist/`:** per project rules, `src/` is the source of truth; `npm run compile` is only for VSIX packaging.

## Dependencies

None — this is a standalone bugfix with no prerequisite plans.

## Adversarial Synthesis

**Key risks:** (1) The `setTimeout(300)` safety net is non-deterministic — on a slow machine the webview may not have mounted its listener in 300ms; however, the real fix (change #1) does not depend on it. (2) The `openMemoTab` IPC handler retains default `persist=true`, causing a redundant same-value write on the cold safety-net path — harmless but technically a programmatic persist. (3) Any downstream code relying on `renderAgentList()` re-applies echoing `setActiveSubTab` would break — no such dependency was found in the codebase. **Mitigations:** The persist-flag approach removes the race entirely rather than trying to win it; the `setActiveTab` precedent at line 2007 proves the pattern is idiomatic; the safety net is additive and idempotent so its failure mode is a no-op, not a regression.

## Proposed Changes

### 1. `src/webview/implementation.html` — make `switchAgentTab` persist only on user action

Add a `persist` parameter (default `true`, so existing user-click callers are unchanged) and guard the `setActiveSubTab` post with it. Then pass `false` from the two programmatic re-render call sites and from the `initialState` restore.

This mirrors the existing `setActiveTab(tab, persist = true)` pattern at `implementation.html:2007-2014`, which already guards its `setActiveTab` post with `if (persist)`. The sub-tab helper simply never received the same treatment.

**`switchAgentTab` definition (around line 2584):**

```js
function switchAgentTab(tab, persist = true) {
    const isChanging = currentAgentTab !== tab;
    currentAgentTab = tab;
    // Only a genuine user tab click should persist the selection. Programmatic
    // re-applies during renderAgentList() must NOT echo setActiveSubTab back to
    // the host — on cold boot that echo overwrites the 'memo' value that
    // openMemoTab() persisted, sending the user to Terminals instead of Memo.
    // Mirrors the existing setActiveTab(tab, persist = true) guard at line 2007.
    if (persist) {
        vscode.postMessage({ type: 'setActiveSubTab', tab: tab });
    }
    const tabs = {
        agents: agentListStandard,
        terminals: agentListTerminals,
        memo: document.getElementById('agent-list-memo')
    };
    // …unchanged below…
```

**`initialState` restore (around line 2182)** — restoring a host-provided value must not write it back:

```js
const validSubTabs = ['agents', 'terminals', 'memo'];
const restoredSubTab = (message.activeSubTab && validSubTabs.includes(message.activeSubTab)) ? message.activeSubTab : 'terminals';
switchAgentTab(restoredSubTab, false); // host is the source of this value — do not echo it back
```

**`renderAgentList()` re-applies (lines 2963 and 3081)** — visibility restore only, never persist:

```js
// line ~2963 (onboarding-guard early return)
switchAgentTab(currentAgentTab, false);
```

```js
// line ~3081 (normal end of renderAgentList)
switchAgentTab(currentAgentTab, false);
```

**Leave unchanged:** the user-click binding at `implementation.html:2639`
(`btn.addEventListener('click', () => switchAgentTab(btn.dataset.tab));`) — it uses the
default `persist = true`, which is exactly what we want for a real click.

**Leave unchanged:** the `openMemoTab` message handler at `implementation.html:2203`
(`switchAgentTab('memo');`) — default-persist is fine here (it reaffirms the Memo
selection on the warm path).

### 2. (Optional hardening) `src/services/TaskViewerProvider.ts` — re-assert Memo intent after cold resolve

Change #1 alone fixes the reported bug. As defence-in-depth against the dropped step-3 message on cold open, have `openMemoTab()` re-post `openMemoTab` shortly after the focus resolves the view, so the webview switches even if `initialState` ordering ever regresses. This is purely additive and idempotent.

**`openMemoTab()` (around line 2649):**

```js
public async openMemoTab(): Promise<void> {
    // 1. Persist so a *cold* open restores straight to Memo via _sendInitialState.
    await this._context.workspaceState.update(TaskViewerProvider.ACTIVE_SUB_TAB_STATE_KEY, 'memo');
    // 2. Reveal the sidebar (resolves the view if not yet created).
    await vscode.commands.executeCommand('switchboard-view.focus');
    // 3. If the view is already live, switch immediately (initialState won't re-fire).
    this._view?.webview.postMessage({ type: 'openMemoTab' });
    // 4. Cold-open safety net: on first-ever resolve the webview's message
    //    listener may not be mounted when step 3 fires, so re-assert Memo once
    //    the webview has had a moment to mount. Idempotent — switchAgentTab to a
    //    tab already active is a no-op.
    //    NOTE: This is a non-deterministic timer-based re-assert, not the fix.
    //    The fix is change #1 (removing the clobber loop). A timer is chosen
    //    over an event-driven _pendingMemoOpen flag + 'ready' handler because
    //    it is simpler, adds no host-side state, and its failure mode is a
    //    no-op (the persisted 'memo' + initialState restore already handle the
    //    cold path correctly once the clobber is removed).
    setTimeout(() => {
        this._view?.webview.postMessage({ type: 'openMemoTab' });
    }, 300);
}
```

> Note: keep step 2 (#1's persisted `'memo'`) as the primary mechanism — the `setTimeout` is only a belt-and-braces re-assert, not the fix. The real fix is removing the clobber in change #1.

## Verification Plan

### Automated Tests

Per session directives, automated tests are NOT run as part of this plan — the user will run the test suite separately. The following test is recommended for the user to add or run:

- Extend a `TaskViewerProvider` test (under `src/services/__tests__/` or `src/test/`) to assert that after `openMemoTab()` followed by a simulated cold `resolveWebviewView` + an early `terminalStatuses`/`setActiveSubTab('terminals')` echo, the persisted `ACTIVE_SUB_TAB_STATE_KEY` remains `'memo'` and the emitted `initialState` carries `activeSubTab: 'memo'`. This directly validates that the clobber loop is broken.

### Manual (primary — this is a cold-start UX race)

1. Build/install the VSIX (`npm run compile` only if packaging) and **fully restart VS Code** so the Switchboard sidebar has *not* been resolved this session.
2. Ensure the Memo status-bar button is visible (`switchboard.statusBar.showMemoButton` = true) or use the hub Memo link.
3. **Without first opening the Switchboard sidebar**, click the Memo status-bar item.
   - **Expected:** sidebar opens directly on the **Memo** sub-tab; the memo textarea is shown and `memoLoad` populates content.
   - **Before fix:** sidebar opens on **Terminals**.
4. Repeat several times across cold restarts to shake out the message-ordering race.
5. **Warm path regression:** with the sidebar already open on Terminals, click the Memo status-bar item → switches to Memo immediately (unchanged).
6. **User-click persistence regression:** click Terminals, click Agents, click Memo manually; reload the window → the last manually selected sub-tab is restored (confirms genuine clicks still persist via `setActiveSubTab`).
7. **Re-render regression:** while sitting on the Terminals tab, open/close an agent terminal to trigger `terminalStatuses` → `renderAgentList()`; confirm the tab does not flicker or change selection and that no spurious `setActiveSubTab` is persisted (the active tab survives a window reload).

---

**Recommendation:** Complexity 3 → **Send to Intern.** The primary fix is a single-file change mirroring an existing codebase pattern (`setActiveTab` at line 2007), with a complete call-site inventory (5 sites, all addressed). The optional hardening is a 4-line additive `setTimeout`. No new state, no schema changes, no architectural risk.

---

## Reviewer Pass — 2026-06-26

### Stage 1: Adversarial Findings

| # | Severity | Location | Finding |
|---|----------|----------|---------|
| 1 | NIT | `TaskViewerProvider.ts:2689-2691` | Dangling `setTimeout` with no `clearTimeout` on dispose. Harmless — optional chaining + VS Code disposed-webview no-op semantics make it safe. Noted for linter hygiene. |
| 2 | NIT | `TaskViewerProvider.ts:2689-2691` | Rapid-click timer stacking (no debounce). Idempotent and harmless — `isChanging=false` after first, `memoLoad` doesn't re-fire, `setActiveSubTab` is redundant same-value. Unrealistic user behavior. |
| 3 | NIT | `implementation.html:2200` | `openMemoTab` IPC handler retains `persist=true` with no explanatory comment. Documented in plan as intentional, but a future developer could "fix" it to `persist=false` and break the warm-path re-assert. |

**No CRITICAL findings. No MAJOR findings.**

### Stage 2: Balanced Synthesis

- **Keep as-is:** Core persist-flag fix on `switchAgentTab`, all 5 call-site `persist` values, `setTimeout` safety net. All verified correct.
- **Fix now:** NIT-3 — added explanatory comment at `implementation.html:2200` to prevent future well-intentioned breakage.
- **Defer:** NIT-1 (dangling timer) and NIT-2 (timer stacking) — both harmless, fixing adds complexity for zero user benefit.

### Code Fixes Applied

- `src/webview/implementation.html:2199-2206` — Added 4-line comment explaining why `persist=true` (default) is intentional for the `openMemoTab` IPC handler. No behavioral change.

### Static Verification Results

Per session directives, compilation (`npm run compile`) and automated tests were NOT run. The following static verification was performed:

1. **Call-site audit (5 sites):** All verified with correct `persist` values:
   - `implementation.html:2179` — `switchAgentTab(restoredSubTab, false)` (initialState restore) ✓
   - `implementation.html:2204` — `switchAgentTab('memo')` (openMemoTab IPC, default persist=true) ✓
   - `implementation.html:2639` — `switchAgentTab(btn.dataset.tab)` (user click, default persist=true) ✓
   - `implementation.html:3006` — `switchAgentTab(currentAgentTab, false)` (renderAgentList onboarding) ✓
   - `implementation.html:3124` — `switchAgentTab(currentAgentTab, false)` (renderAgentList normal) ✓
2. **`setActiveSubTab` single-source:** Posted from exactly ONE location — inside the `if (persist)` guard at `implementation.html:2582`. ✓
3. **Host-side `_sendInitialState`:** Reads `ACTIVE_SUB_TAB_STATE_KEY` (line 5438) and sends `activeSubTab` in `initialState` message (line 5480). ✓
4. **Host-side `setActiveSubTab` handler:** Persists to `workspaceState` with valid-sub-tab clamping (lines 9584-9588). ✓
5. **Clobber path broken:** `terminalStatuses` (line 2227) → `renderAgentList()` → `switchAgentTab(currentAgentTab, false)` (line 3124) — no longer posts `setActiveSubTab`. ✓
6. **`memoLoad` double-fire analysis:** Safe in all 3 message orderings (initialState-first, safety-net-first, simultaneous) — `isChanging` guard ensures exactly one `memoLoad`. ✓
7. **Entry-point audit:** All 4 `switchboard.openMemo` references (extension.ts:796, 1902, 2051, 2188) route through `openMemoTab()`. ✓
8. **No duplicate `switchAgentTab`:** Confirmed only in `implementation.html` — not in `kanban.html` or other webview files. ✓
9. **`setActiveTab` precedent:** Confirmed at `implementation.html:2004-2010` — same `persist = true` guard pattern. ✓
10. **`openMemoTab()` safety net:** Confirmed at `TaskViewerProvider.ts:2681-2692` — persists `'memo'`, focuses view, immediate post, 300ms re-assert. ✓

### Remaining Risks

- **NIT-1 (deferred):** Dangling `setTimeout` — harmless but a future linter/refactor may flag it. If the extension ever adds formal webview disposal cleanup, this timer ID should be tracked and cleared.
- **NIT-2 (deferred):** No debounce on rapid `openMemoTab()` calls — harmless due to idempotency, but unbounded timer creation in theory.
- **Manual testing pending:** The cold-start UX race is inherently a runtime behavior — static verification confirms the logic is correct, but the user should run the manual verification steps (plan lines 191-199) across multiple cold restarts to confirm end-to-end behavior.
- **No automated test added:** The plan recommends (line 187) a `TaskViewerProvider` test asserting the clobber loop is broken. This has not been added — the user should consider adding it to prevent regression.
