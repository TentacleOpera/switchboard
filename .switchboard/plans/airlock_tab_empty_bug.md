# Bug Report: Airlock Tab Has No Content

## Goal
Fix the inverted conditional in `renderAgentList()` that prevents the Airlock panel from being created when the Airlock tab is active, causing the tab to display as empty. The fix must address **three** change sites in a single file: the `innerHTML` clearing guard, the panel append guard, and the identical bug in the onboarding guard.

## Metadata
**Tags:** frontend, bugfix, UI
**Complexity:** 3

## User Review Required
> [!NOTE]
> Single-file fix in the webview HTML. No backend changes. No breaking changes. The Autoban and Agents tabs are unaffected; this only changes how the Airlock (webai) tab content is rendered and cleared during `renderAgentList()` cycles.

## Complexity Audit
### Routine
- Remove conditional guard around `agentListWebai.innerHTML = ''` (line 3399) — make clearing unconditional, matching `agentListStandard` and `agentListAutoban` which are already unconditional at lines 3395-3396.
- Remove conditional guard around `agentListWebai.appendChild(createWebAiAirlockPanel())` (line 3495) — make append unconditional, matching the Autoban pattern at line 3492.
- Remove conditional guard around `agentListWebai.appendChild(createWebAiAirlockPanel())` in the onboarding guard (line 3376) — same fix, different code path.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. `renderAgentList()` is synchronous DOM manipulation. The `switchAgentTab()` call at line 3500 always runs after the panel is appended, so visibility toggling is deterministic.
- **Security:** No security implications — this is a purely cosmetic DOM rendering fix.
- **Side Effects:** Making the `innerHTML` clearing unconditional means the Airlock panel DOM is now destroyed and recreated on every `renderAgentList()` call, even while the user is viewing it. This matches the existing behavior of the Agents tab (`agentListStandard.innerHTML = ''` at line 3395) and the Autoban tab (`agentListAutoban.innerHTML = ''` at line 3396), so it is consistent. No stateful input fields exist in the Airlock panel that would be lost.
- **Dependencies & Conflicts:**
  - **`refactor_onboarding_state_synchronization.md`** — This plan refactors the onboarding flow and touches the onboarding guard area (lines 3374-3381). If both plans land, the onboarding guard fix (Change Site 1 below) may produce a merge conflict. **Resolution:** This bugfix is minimal (single-line conditional removal); the refactor plan should absorb it. Document for the implementer.
  - No other active plans modify `renderAgentList()` or the Airlock tab rendering.

## Root Cause

In `renderAgentList()` inside `src/webview/implementation.html`, two paired operations protect the webai (Airlock) container with an inverted conditional:

**Clearing (lines 3398-3401):**
```javascript
const webaiTabActive = currentAgentTab === 'webai';
if (!webaiTabActive) {
    agentListWebai.innerHTML = '';
}
```

**Appending (lines 3494-3497):**
```javascript
// === AIRLOCK TAB: Bundle, Convert to Plan, Send to Coder ===
if (!webaiTabActive) {
    agentListWebai.appendChild(createWebAiAirlockPanel());
}
```

**The Bug**: The Airlock panel content (`createWebAiAirlockPanel()`) is only created when `webaiTabActive` is FALSE. This means:
- When the user is on the "Agents" tab, the Airlock content IS created (but hidden via CSS class)
- When the user clicks on the "Airlock" tab, `currentAgentTab` becomes `'webai'`, making `webaiTabActive` TRUE
- When any event triggers `renderAgentList()` while `webaiTabActive` is TRUE, the content is NOT re-created, AND — critically — it was already cleared by a prior render cycle, leaving the tab empty

The same bug exists in the onboarding guard (lines 3376-3378):
```javascript
if (currentAgentTab !== 'webai') {
    agentListWebai.appendChild(createWebAiAirlockPanel());
}
```

**Clarification:** The original plan proposed removing only the append conditional. This is **insufficient** — if the append is made unconditional but the `innerHTML` clearing remains conditional, then when `webaiTabActive` is true the container is NOT cleared before appending, causing **duplicate panel DOM nodes** on each re-render. Both the clearing and the appending must be made unconditional together.

The correct pattern already exists for the other two tabs:
- `agentListStandard.innerHTML = ''` (line 3395) — unconditional
- `agentListAutoban.innerHTML = ''` (line 3396) — unconditional
- `agentListAutoban.appendChild(createAutobanPanel())` (line 3492) — unconditional

## Adversarial Synthesis

### Grumpy Critique
> Oh, *splendid*. Someone tried to be clever with a "don't re-render while active" optimization and introduced a bug that makes the entire tab empty. Classic premature optimization — saved zero measurable milliseconds, broke an entire feature.
>
> But here's what REALLY grinds my gears: the original fix proposal only removes the append conditional and leaves the clearing conditional intact. Congratulations, you've just traded "empty tab" for "infinite duplicate panels stacking up on every re-render." Did anyone actually trace BOTH code paths? The clearing at line 3399 and the appending at line 3495 are a PAIRED operation. You fix one, you fix both, or you ship a new bug.
>
> And while we're at it — the onboarding guard at line 3376 has the SAME inverted conditional. The original plan mentions it in "Additional Context" like a fun fact instead of listing it as a mandatory fix site. If you ship without fixing the onboarding guard path, users who complete onboarding while on the Airlock tab get... an empty Airlock tab. Déjà vu.
>
> At least it's a single file. Small mercies.

### Balanced Response
Grumpy's critique is correct on all three points:

1. **Paired operation fix** — The `innerHTML` clearing (line 3399) and the `appendChild` (line 3495) must both be made unconditional. The implementation below addresses both.
2. **Onboarding guard** — The conditional at line 3376 is a third change site that must be fixed in the same commit. It is included as Change Site 1 below.
3. **Risk is genuinely low** — This aligns the Airlock tab with the identical unconditional pattern used by `agentListStandard` and `agentListAutoban`. The `switchAgentTab()` function at line 3500/3379 handles visibility correctly regardless.

## Proposed Changes

### Change Site 1: Onboarding Guard — Unconditional Airlock Panel Append
#### [MODIFY] `src/webview/implementation.html`
- **Context:** The onboarding guard (lines 3374-3380) is an early-return path in `renderAgentList()`. It creates the Autoban panel unconditionally but wraps the Airlock panel in `if (currentAgentTab !== 'webai')`, causing the same empty-tab bug when onboarding completes while the Airlock tab is active.
- **Logic:**
  1. Remove the `if (currentAgentTab !== 'webai')` guard around the `appendChild` call.
  2. The Airlock panel will now always be created in the onboarding guard path, matching the Autoban panel pattern on the line above.
- **Implementation:**

Change lines 3375-3378 from:
```javascript
agentListAutoban.appendChild(createAutobanPanel());
if (currentAgentTab !== 'webai') {
    agentListWebai.appendChild(createWebAiAirlockPanel());
}
```
To:
```javascript
agentListAutoban.appendChild(createAutobanPanel());
agentListWebai.appendChild(createWebAiAirlockPanel());
```

- **Edge Cases Handled:** If onboarding completes while the user is viewing the Airlock tab, the panel is now created. `switchAgentTab(currentAgentTab)` at line 3379 handles visibility.

### Change Site 2: Main Render Path — Unconditional innerHTML Clearing
#### [MODIFY] `src/webview/implementation.html`
- **Context:** Lines 3395-3401 clear the three tab containers before rebuilding. `agentListStandard` and `agentListAutoban` are cleared unconditionally, but `agentListWebai` is guarded by `if (!webaiTabActive)`. This must be made unconditional to prevent duplicate DOM nodes when the append (Change Site 3) is also made unconditional.
- **Logic:**
  1. Remove the `const webaiTabActive` variable (it is only used for these two conditionals and becomes unused after both are removed).
  2. Clear `agentListWebai.innerHTML` unconditionally, on the same line as the other two clearings.
- **Implementation:**

Change lines 3395-3401 from:
```javascript
agentListStandard.innerHTML = '';
agentListAutoban.innerHTML = '';

const webaiTabActive = currentAgentTab === 'webai';
if (!webaiTabActive) {
    agentListWebai.innerHTML = '';
}
```
To:
```javascript
agentListStandard.innerHTML = '';
agentListAutoban.innerHTML = '';
agentListWebai.innerHTML = '';
```

- **Edge Cases Handled:** Prevents duplicate Airlock panels. The Airlock panel has no stateful input fields (unlike the Analyst row which has special snapshot/restore logic at lines 3387-3461), so destroying and recreating it is safe.

### Change Site 3: Main Render Path — Unconditional Airlock Panel Append
#### [MODIFY] `src/webview/implementation.html`
- **Context:** Lines 3494-3497 append the Airlock panel, guarded by `if (!webaiTabActive)`. This is the primary bug site — the panel is only created when the user is NOT on the Airlock tab.
- **Logic:**
  1. Remove the `if (!webaiTabActive)` guard.
  2. Append `createWebAiAirlockPanel()` unconditionally, matching the Autoban pattern at line 3492.
- **Implementation:**

Change lines 3494-3497 from:
```javascript
// === AIRLOCK TAB: Bundle, Convert to Plan, Send to Coder ===
if (!webaiTabActive) {
    agentListWebai.appendChild(createWebAiAirlockPanel());
}
```
To:
```javascript
// === AIRLOCK TAB: Bundle, Convert to Plan, Send to Coder ===
agentListWebai.appendChild(createWebAiAirlockPanel());
```

- **Edge Cases Handled:** Combined with Change Site 2, the container is always cleared then rebuilt, preventing duplicates. `switchAgentTab(currentAgentTab)` at line 3500 sets the correct visibility.

## Verification Plan
### Automated Tests
- No existing automated tests cover webview DOM rendering (this is inline HTML/JS in a VS Code webview).

### Manual Verification Steps
1. Open the Switchboard sidebar.
2. Click the "Airlock" tab — verify it displays the Airlock panel content (bundle, convert-to-plan, send-to-coder controls).
3. Switch to "Agents" tab, then back to "Airlock" — verify content persists across tab switches.
4. Trigger a re-render (e.g., change agent visibility settings) while on the Airlock tab — verify content is still present after re-render.
5. Complete the onboarding flow while on the Airlock tab — verify content appears immediately.
6. Verify Autoban tab still renders correctly (regression check).

### Recommendation
**Send to Coder** (Complexity 3 — single-file, three-line change with clear pattern to follow).

---

## Reviewer Pass

### Status: ✅ COMPLETE (with 1 fix applied)

### Stage 1 — Grumpy Principal Engineer

> Oh, *bravo*. The plan meticulously documents that clearing and appending are a **paired operation** — spends an entire paragraph in the Root Cause explaining how fixing one without the other creates duplicate DOM nodes — and then the implementation **does exactly that** in the onboarding guard path.
>
> Let me spell it out: Change Site 1 made the *append* unconditional at line 3376. Wonderful. But the *clearing* at lines 3347-3349 is still wrapped in `if (currentAgentTab !== 'webai')`. So when the user is on the Airlock tab and the onboarding guard fires repeatedly (which it will — `renderAgentList()` is called on every agent state change), the container is NOT cleared but a new panel IS appended. **Duplicate DOM nodes stacking up on every re-render.** The very bug the plan's own Adversarial Synthesis warned about, transposed from the main render path to the onboarding path.
>
> The three plan-specified change sites (Change Sites 1, 2, 3) are all correctly implemented. The main render path is clean — unconditional clear at line 3393, unconditional append at line 3487. No complaints there.
>
> But the onboarding guard has FOUR operations on webai, not two: clear + append. The plan only listed the append as Change Site 1 and forgot the paired clearing. The implementer faithfully followed the plan and inherited the gap.
>
> **Severity: CRITICAL** — Duplicate DOM nodes on every re-render when Airlock tab is active during onboarding state. Same class of bug the plan was designed to fix.

### Stage 2 — Balanced Synthesis

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| 1 | Onboarding guard clearing (line 3347) still conditional — paired-operation violation with unconditional append at line 3376 | **CRITICAL** | **Fix now** — make clearing unconditional, matching the main render path pattern |
| 2 | Change Site 1 (onboarding append): unconditional ✅ | — | Keep |
| 3 | Change Site 2 (main render clearing): unconditional, `webaiTabActive` removed ✅ | — | Keep |
| 4 | Change Site 3 (main render append): unconditional ✅ | — | Keep |

**Verdict:** One critical fix needed (onboarding guard clearing). All three plan-specified change sites are correctly implemented.

### Code Fixes Applied

**Fix 1 (CRITICAL):** Made `agentListWebai.innerHTML = ''` unconditional in the onboarding guard path.

Changed lines 3345-3349 in `src/webview/implementation.html` from:
```javascript
agentListStandard.innerHTML = '';
agentListAutoban.innerHTML = '';
if (currentAgentTab !== 'webai') {
    agentListWebai.innerHTML = '';
}
```
To:
```javascript
agentListStandard.innerHTML = '';
agentListAutoban.innerHTML = '';
agentListWebai.innerHTML = '';
```

### Files Changed
- `src/webview/implementation.html` — 1 fix (onboarding guard clearing made unconditional)

### Verification Results
- **TypeScript check:** N/A (file is inline HTML/JS, not compiled by tsc)
- **Pre-existing tsc errors:** 1 unrelated error in `KanbanProvider.ts` (import extension)
- **Automated tests:** No tests exist for webview DOM rendering
- **Manual verification required:** See steps 1-6 in Verification Plan above

### Remaining Risks
- **None material.** All four webai operations (2 clears + 2 appends across onboarding guard and main render path) are now unconditional, matching the existing pattern for `agentListStandard` and `agentListAutoban`.
- **Dependency note:** `refactor_onboarding_state_synchronization.md` touches the onboarding guard area — this fix is minimal (single-line change) and should be absorbed cleanly by that refactor.
