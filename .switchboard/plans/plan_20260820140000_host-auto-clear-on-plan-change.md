# Host-Enforced Auto-Clear on Plan Change

## Goal

Eliminate the "lead forgets to clear terminals between dispatches" failure mode by making context clearing automatic and server-enforced. When a `ptySendPrompt` with a `dispatch` field references a **different planId** than the terminal's last dispatched plan, the host clears the terminal's context (`/clear`) before delivering the new prompt. When the planId is the **same** (a fix resend), context is preserved as today.

### Problem & Root Cause

The coding team lead repeatedly forgets to call `ptyClearTerminal` between subtask dispatches. This is a structural design gap, not carelessness:

1. **`clearBeforePrompt: false` is mandatory on every send** — the dispatch path never clears. This is by design (to preserve context for fix resends), but it means the *only* clearing path is a separate manual `ptyClearTerminal` call.
2. **Clearing is a conditional, mid-turn step** — the lead must review the diff, decide next work, clear the old terminal, then dispatch. The clear is the middle step with no visible output, sandwiched between two steps that do.
3. **No system-level enforcement** — unlike dispatch registration (which returns `directivesAttached` as a receipt) or standing orders (which are durable), clearing has no backstop. If the lead forgets, nothing fires.
4. **The symptom is silent and delayed** — stale context degrades reasoning and induces hallucinated conflicts over multiple subtasks. The feedback loop is too long for the lead to self-correct.

This is the same bug class that standing orders were invented to solve for callbacks: a critical step that depends on an agent remembering to do it every time, with no automatic floor under it. The fix is the same pattern — take the judgment out of the lead's hands.

### Background Context

The `terminal-coder-dispatch` skill (§7) currently teaches manual clearing as a mandatory-for-correctness step: "Clear at rest, always. When a seat's completion has arrived and its next work is a different surface, `ptyClearTerminal` before dispatching." The skill also carries a "same code" exception: context may be kept when the next subtask edits the same code the seat just wrote. This exception requires judgment every time and is a primary source of the forgetting.

The `clearBeforePrompt` field on `ptySendPrompt` already triggers a `/clear` before the prompt in `sendPromptToPty` (`ptyPromptDelivery.ts`, line 74 — `if (opts?.clearBeforePrompt)`). The caller passes `clearBeforePrompt: false` (to preserve resend context), and the host can override this to `true` when it detects a plan change. No new verbs, no new payload fields, no new delivery logic — the mechanism already exists.

## Metadata

**Complexity:** 5
**Tags:** backend, feature, reliability, refactor
**Project:** Browser Switchboard

## User Review Required

This plan modifies the dispatch delivery path on both the extension host and standalone host, updates two copies of a skill document, and updates two contract test files. The approach reuses the existing `clearBeforePrompt` mechanism — no new verbs, no new payload fields. Review the corrected line numbers and the scoping fix before implementation, as the original plan contained errors in both.

## Complexity Audit

### Routine
- Adding a `Map<string, string>` class field / module-level constant
- Conditional override of a boolean field on an existing payload object
- Map delete/clear/rename operations on terminal lifecycle events
- Skill documentation text updates (prose edits)
- Contract test assertion updates (regex/string changes)
- New source-level contract test file (same style as existing tests)

### Complex / Risky
- Call-flow ordering: the `clearBeforePrompt` injection in `handlePtyVerb` (lines 3037-3063) runs BEFORE `_ptyHostVerb` is called (line 3064). The override inside `_ptyHostVerb` must happen AFTER the injection and must set an explicit `true` that the injection (which only acts on `undefined`) won't re-process. The ordering is correct but subtle — an implementer who misreads the call flow could break the injection or the override.
- Scoping: the auto-clear code must be inserted INSIDE the `if (hasDispatch)` block (lines 548-609) in `_ptyHostVerb`, where `planId` is in scope. Inserting after the block's closing brace would cause a ReferenceError.
- Two-host parallelism: the same logic must be applied to both `TaskViewerProvider.ts` (extension host) and `bootstrap.ts` (standalone), with host-specific insertion points and variable names.
- Contract test sensitivity: the `terminal-coder-dispatch-contract.test.js` test at lines 140-150 asserts `/mandatory for correctness/i` and `/[Cc]lear at rest, always/`. The skill text rewrite must either preserve these phrases or update the test assertions.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Concurrent dispatches to the same terminal could read the Map before either writes. In practice, the team lead dispatches one subtask at a time, and `sendLocks` in `ptyPromptDelivery.ts` serialize prompt delivery per terminal. Not a real concern.

**Security:**
- The Map is keyed on terminal friendly name and stores planId strings. No sensitive data. The override only sets `clearBeforePrompt: true` — it does not expose or modify any security-relevant field.

**Side Effects:**
- A redundant auto-clear (Map entry survives a `/clear` via `ptyWrite`) wastes a 600ms settle window but is harmless. Mitigated by adding Map deletion on the `ptyWrite` with `/clear` path.
- `clearTerminalContext` (extension host, line 10206) clears the terminal after `queue/done`. The Map entry should be deleted here too, so the next dispatch doesn't redundantly auto-clear an already-clean terminal.

**Dependencies & Conflicts:**
- The `clearBeforePrompt` injection block in `handlePtyVerb` (lines 3037-3063) and the `clearBeforePrompt` delivery in `sendPromptToPty` (line 74) are the two existing mechanisms this feature builds on. No conflicts — the override produces an explicit `true` that the injection (which only acts on `undefined`) passes through unchanged.
- The seat-cache invalidation at lines 474-499 already handles `ptyClearTerminal`, `ptyRenameTerminal`, and `ptyWrite` with `/clear`. The Map maintenance should mirror these same events for consistency.

## Dependencies

None — this plan is self-contained. No other plan or session must complete first.

## Adversarial Synthesis

Key risks: (1) the original plan contained six wrong line number references and a scoping bug in its proposed code — both corrected in this revision; (2) the `ptyWrite` with `/clear` path was missing from Map maintenance — added; (3) the `planId`-empty case (dispatch with only `planFile`) silently skips auto-clear — documented as a known limitation. Mitigations: all line numbers verified against the actual source; scoping fixed by moving insertion inside the `if (hasDispatch)` block; `ptyWrite` with `/clear` added to Map maintenance; `planId`-empty limitation documented alongside the parse-based backstop limitation.

## Proposed Changes

### 1. In-memory last-dispatched-plan tracking

Add a `Map<string, string>` (terminal friendlyName → last dispatched planId) on each host. This is the state the auto-clear decision reads.

**Extension host** (`TaskViewerProvider.ts`):
- Add `private _lastDispatchedPlanByTerminal = new Map<string, string>();` as a class field.

**Standalone** (`bootstrap.ts`):
- Add a module-level `const lastDispatchedPlanByTerminal = new Map<string, string>();` near the `seatBlockCache` declaration (same scope, same lifetime).

**Why in-memory, not DB-backed:** On host restart, terminals are fresh pty processes with no stale context — there is nothing to clear. The map being empty on restart is correct, not a gap. A DB-backed approach would require a new column or table, add migration burden, and serve no case the in-memory map doesn't cover.

### 2. Auto-clear logic on dispatch (extension host)

In `_ptyHostVerb` (`TaskViewerProvider.ts`, line 450), INSIDE the `if (hasDispatch)` block (lines 548-609), after `directivesAttached` is set (lines 606-608) and BEFORE the block's closing brace at line 609, insert the auto-clear check:

```typescript
// After directivesAttached is set, before the if (hasDispatch) block closes.
// planId is in scope here (declared at line 555). hasDispatch is already true
// (we're inside the block), so no outer guard is needed.
if (planId) {
    const lastPlanId = this._lastDispatchedPlanByTerminal.get(payload.name);
    if (lastPlanId && lastPlanId !== planId) {
        // Plan changed — override clearBeforePrompt to true so sendPromptToPty
        // writes /clear before the prompt. The caller's explicit false is
        // intentionally overridden: the host knows the plan changed, the
        // caller does not.
        payload = { ...payload, clearBeforePrompt: true };
    }
    this._lastDispatchedPlanByTerminal.set(payload.name, planId);
}
```

> **Superseded:** The original plan proposed inserting this code "after line 609, after `directivesAttached` is set" with an `if (hasDispatch && planId)` wrapper.
> **Reason:** Line 609 is the closing brace of the `if (hasDispatch)` block. `planId` is declared inside that block (line 555) and is not in scope after line 609. Inserting outside the block would cause a ReferenceError. The `hasDispatch` guard is redundant inside the block.
> **Replaced with:** Insert INSIDE the `if (hasDispatch)` block, before line 609, with the `hasDispatch` guard removed and an `if (planId)` guard added (to skip tracking when the dispatch has only `planFile` and no `planId`).

**Call-flow ordering (corrected):** `handlePtyVerb` (line 2894) runs the `clearBeforePrompt` injection at lines 3037-3063, then calls `this._ptyHostVerb(verb, payload, signal)` at line 3064. Inside `_ptyHostVerb` (line 450), the dispatch processing happens at lines 548-609. The injection only acts on `clearBeforePrompt === undefined` (lines 3038, 3045), so an explicit `true` set inside `_ptyHostVerb` is unaffected — it goes straight to the pty host child as `true`.

> **Superseded:** The original plan stated the injection was at "lines 2989-3015" and the `_ptyHostVerb` call was at "line 3016," with `handlePtyVerb` at "line 2846."
> **Reason:** All three line numbers were wrong. `handlePtyVerb` starts at line 2894 (line 2846 is `updateMirrorRegistry`). The injection block is at lines 3037-3063 (lines 2989-3018 are the `ptyCreateBatch` cwd resolution). The `_ptyHostVerb` call is at line 3064 (line 3016 is inside the `ptyCreateBatch` block).
> **Replaced with:** The correct line numbers: `handlePtyVerb` at 2894, injection at 3037-3063, `_ptyHostVerb` call at 3064. The architectural reasoning (injection runs before `_ptyHostVerb`, override inside `_ptyHostVerb` is not re-processed) is correct — only the line numbers were wrong.

> **Superseded:** The original plan contained a self-correcting reasoning draft: "Wait — let me re-check the call flow."
> **Reason:** This was a thinking artifact left in the document body, not a plan instruction. It read as if the plan was uncertain about its own architecture.
> **Replaced with:** The clean, verified statement above — the call flow is confirmed correct against the actual source.

**Parse-based dispatch backstop:** The extension host also has a parse-based path (lines 542-547) that scrapes plan identity from the prompt body when no `dispatch` field is supplied. This path produces `parsedDispatchIdentity` with `planFiles` (not `planId`). For the initial implementation, the auto-clear logic will only apply to the explicit `dispatch` field path. The parse-based path is a backstop for callers that don't use `dispatch` (the board's paste/drop path); those callers are not the team-lead dispatch path this feature targets. Document this as a known limitation in the plan's Verification section.

**`planId`-empty limitation:** A dispatch can carry a `planFile` without a `planId`. The `if (planId)` guard skips Map tracking in this case, so no auto-clear fires. This is correct (no `planId` to compare), but should be documented as a known limitation alongside the parse-based backstop. The team-lead dispatch path always supplies a `planId`, so this gap doesn't affect the target use case.

### 3. Auto-clear logic on dispatch (standalone)

In `bootstrap.ts`'s `ptySendPrompt` case (line 1573), INSIDE the `if (payload.dispatch !== undefined && payload.dispatch !== null)` block (lines 1612-1652), after `directivesAttached` is set (line 1651) and BEFORE the block's closing brace at line 1652, insert the same check:

```typescript
// After directivesAttached is set, before the dispatch block closes.
// parsed.value.planId is in scope here (declared at line 1619).
if (parsed.value.planId) {
    const lastPlanId = lastDispatchedPlanByTerminal.get(payload.name);
    if (lastPlanId && lastPlanId !== parsed.value.planId) {
        // Plan changed — set payload.clearBeforePrompt = true so the
        // resolvedClear computation at lines 1655-1657 picks up true
        // (typeof payload.clearBeforePrompt === 'boolean' → resolvedClear
        // = payload.clearBeforePrompt = true). This mirrors the extension
        // host's payload override approach.
        payload.clearBeforePrompt = true;
    }
    lastDispatchedPlanByTerminal.set(payload.name, parsed.value.planId);
}
```

**Why set `payload.clearBeforePrompt = true` instead of overriding `resolvedClear`:** The `resolvedClear` variable is declared at line 1655, AFTER the dispatch block closes at line 1652. Setting `payload.clearBeforePrompt = true` inside the dispatch block means the `resolvedClear` computation at line 1655 (`typeof payload.clearBeforePrompt === 'boolean' ? payload.clearBeforePrompt : ...`) naturally picks up `true`. This is cleaner than declaring a flag and checking it after `resolvedClear` is computed, and it mirrors the extension host's approach of overriding the payload field.

### 4. Map maintenance on terminal lifecycle events

**`ptyClearTerminal`** — both hosts: delete the map entry for the cleared terminal. The terminal is now clean; the next dispatch should not auto-clear (nothing to clear).

- Extension host: in `_ptyHostVerb`, the existing seat-cache-drop block at lines 474-499 already detects `ptyClearTerminal` (line 475). Add `this._lastDispatchedPlanByTerminal.delete(payload.name)` alongside the seat cache drop (inside the `if (typeof seatCacheDropName === 'string')` block, after the seat cache loop at lines 480-484).
- Standalone: in `bootstrap.ts`'s `ptyClearTerminal` case (line 1556), add `lastDispatchedPlanByTerminal.delete(payload.name)` alongside `seatBlockCache.delete(handle.agentInstanceId)` at line 1560.

**`ptyClearAllTerminals`** — both hosts: clear the entire map.

- Extension host: in the `ptyClearAllTerminals` branch at line 497, add `this._lastDispatchedPlanByTerminal.clear()` alongside `this._seatBlockCache.clear()` at line 498.
- Standalone: in `bootstrap.ts`'s `ptyClearAllTerminals` case (line 1684), add `lastDispatchedPlanByTerminal.clear()` alongside `seatBlockCache.clear()` at line 1685.

**`ptyWrite` with `/clear`** — both hosts: delete the map entry. The seat-cache invalidation at lines 474-499 (extension host) already detects this path (`verb === 'ptyWrite' && String(payload?.data ?? '').trim() === '/clear'` at line 476). The standalone host does not have this detection in the `ptyWrite` case — check whether the standalone `ptyWrite` handler needs the same Map delete. If the standalone host's `ptyWrite` case does not have seat-cache invalidation for `/clear`, the Map delete can be omitted there (the standalone sidebar's clear button uses `ptyClearTerminal`, not bare `ptyWrite`).

- Extension host: add `this._lastDispatchedPlanByTerminal.delete(payload.name)` inside the seat-cache-drop block (lines 479-484), which already fires for `ptyWrite` with `/clear` via the `seatCacheDropName` check at line 476.
- Standalone: verify whether the `ptyWrite` case handles `/clear`. If not, omit — the standalone clear path uses `ptyClearTerminal`.

**`ptyCloseTerminal`** — both hosts: delete the map entry (terminal is gone).

- Extension host: `ptyCloseTerminal` is NOT currently in the seat-cache-drop list (lines 474-478 only include `ptyClearTerminal`, `ptyRenameTerminal`, and `ptyWrite` with `/clear`). Add a new check: `if (verb === 'ptyCloseTerminal' && typeof payload?.name === 'string') { this._lastDispatchedPlanByTerminal.delete(payload.name); }` in `_ptyHostVerb`, before the seat-cache-drop block or alongside it.
- Standalone: in `bootstrap.ts`'s `ptyCloseTerminal` case (line 1470), add `lastDispatchedPlanByTerminal.delete(payload.name)`.

**`ptyRenameTerminal`** — both hosts: rename the map entry (old name → new name).

- Extension host: in the existing `ptyRenameTerminal` detection at line 475 (inside the seat-cache-drop block), add a map key rename: `const oldPlan = this._lastDispatchedPlanByTerminal.get(payload.name); if (oldPlan) { this._lastDispatchedPlanByTerminal.delete(payload.name); this._lastDispatchedPlanByTerminal.set(payload.alias, oldPlan); }`. Note: `payload.alias` is the new name (verified at line 3077 where `rewriteStandingOrdersForRename` uses `payload.alias`).
- Standalone: in `bootstrap.ts`'s `ptyRenameTerminal` case (line 1543), add the same map key rename alongside the existing `seatBlockCache` and standing-orders rewrite logic.

> **Superseded:** The original plan stated `ptyRenameTerminal` in bootstrap.ts was at "line 162."
> **Reason:** Line 162 is inside `buildDispatchAnalysisPrompt`, a completely different function. The actual `ptyRenameTerminal` case is at line 1543.
> **Replaced with:** Line 1543 — the correct location of the `ptyRenameTerminal` case in `bootstrap.ts`.

**`clearTerminalContext`** (extension host only, line 10206): this is called after `queue/done` and already clears the terminal. Add `this._lastDispatchedPlanByTerminal.delete(terminalName)` so the next dispatch doesn't redundantly auto-clear an already-clean terminal. This is an optimization (redundant clear is harmless but wastes the settle window), not a correctness requirement.

> **Superseded:** The original plan stated `clearTerminalContext` was at "line 10158."
> **Reason:** The method definition is at line 10206, not 10158. Line 10158 is inside a different section of the file.
> **Replaced with:** Line 10206 — the correct location of the `clearTerminalContext` method definition.

### 5. Skill documentation updates

Update **both copies** of `terminal-coder-dispatch/SKILL.md`:
- `.agents/skills/terminal-coder-dispatch/SKILL.md`
- `.claude/skills/terminal-coder-dispatch/SKILL.md`

**§0 Quick Start** — update step 6:
- Current: "Clear a terminal only when at rest (completion + next work elsewhere)."
- New: "The host auto-clears a terminal when you dispatch a different plan to it. Manually clear with `ptyClearTerminal` only when standing a terminal down without dispatching new work to it."

**§1 `clearBeforePrompt: false` is mandatory** — add a note after the existing explanation:
- "The host overrides this to `true` automatically when the `dispatch` field references a different planId than the terminal's last dispatched plan. The caller still passes `false`; the host's override is not visible to the caller and does not change the caller's contract."

**§7 Resting a terminal** — rewrite to reflect the new auto-clear:
- The "Why this step is mandatory for correctness" paragraph becomes: "The host auto-clears a terminal when a dispatch references a different plan. This is mandatory for correctness — stale context degrades reasoning and induces hallucinated conflicts over multiple subtasks. Manual `ptyClearTerminal` is now for the stand-down case only — a terminal you are putting away without dispatching new work to it. The `clearBeforePrompt: false` rule is unchanged: the caller passes `false`, the host overrides to `true` on plan change. Clear at rest, always — the auto-clear enforces this at the system level; the manual clear enforces it for the stand-down path."
- The "same code" exception is removed — every new plan gets a fresh context. Document this explicitly: "The previous 'same code' exception (keeping context when the next subtask edits the same code) is removed. Every new plan dispatch gets a fresh context. If a resend needs context, it carries the same planId and the host preserves it."
- The three load-bearing rules (never clear yourself, only clear at rest, standing orders survive a clear) remain. "Only clear at rest" now applies to the manual stand-down path, not the auto-clear path (which is gated on planId change, a stricter condition).

**Note on "mandatory for correctness" and "Clear at rest, always":** The `terminal-coder-dispatch-contract.test.js` test at lines 140-150 asserts `/mandatory for correctness/i` and `/[Cc]lear at rest, always/`. The §7 rewrite above preserves both phrases — "mandatory for correctness" is retained (applied to the auto-clear mechanism, which IS mandatory for correctness) and "Clear at rest, always" is retained (applied to both the auto-clear and manual paths). No test assertion change is needed for this test.

**§5.6 unattended default-action table** — update the "A seat has reported and its next work is a different surface" row:
- Current: "Clear it, **in the same turn as the review**, before dispatching anything else."
- New: "The host auto-clears on plan change — no manual action needed. If standing the terminal down without new work, `ptyClearTerminal` it."

**§5.6 "Keeping a seat's context across subtasks" row** — update:
- Current: "Allowed only when the next subtask edits code that seat just wrote, stated in the dispatch, and re-decided at every hand-off."
- New: "Not applicable — the host auto-clears on plan change. Context is preserved only for same-plan resends (fix prompts), which carry the same planId."

### 6. Contract test updates

**`proactive-terminal-rest-clear-contract.test.js`** (89 lines total):

- Lines 47-53: The test asserts the skill does NOT contain `"clearBeforePrompt": true` (as a JSON-style string with quotes and colon). The proposed skill text says "The host overrides this to `true` automatically" — this is prose with backtick-quoted `true`, NOT the JSON pattern `"clearBeforePrompt": true`. The regex `/"clearBeforePrompt"\s*:\s*true/` will NOT match the prose. **This test passes as-is — no change needed.** The original plan's concern about updating this assertion was a false alarm. Optionally, add a clarifying comment to the test noting that host-side auto-clear prose is allowed while caller-side JSON `true` is not, but this is cosmetic.

> **Superseded:** The original plan referenced "Line 140-150" in `proactive-terminal-rest-clear-contract.test.js` for the "clear-at-rest is mandatory for correctness" assertion.
> **Reason:** This file is only 89 lines long — lines 140-150 do not exist. The "mandatory for correctness" test is in `terminal-coder-dispatch-contract.test.js` at lines 140-150. The two test files were confused.
> **Replaced with:** The correct file (`terminal-coder-dispatch-contract.test.js`) and line numbers (140-150) for the "mandatory for correctness" assertion. The `proactive-terminal-rest-clear-contract.test.js` assertions at lines 47-53 (the `clearBeforePrompt: false` test) do not need updating.

**`terminal-coder-dispatch-contract.test.js`** (236 lines total):

- Lines 140-150: The "clear-at-rest rule is stated as mandatory for correctness" test. Asserts `/mandatory for correctness/i` and `/[Cc]lear at rest, always/`. The §7 skill rewrite preserves both phrases (see §5 above), so **no test change is needed** — the assertions will still pass.
- Lines 207-229: The §7 regression guard tests. These assert "Never clear yourself", "ptyClearAllTerminals", "Only clear a terminal that is genuinely at rest", "no busy check", "Standing orders survive a clear". These rules survive in the new framing — verify and update only if wording changes. The §7 rewrite above retains all five phrases.

### 7. New tests for auto-clear behavior

**`host-auto-clear-on-plan-change.test.js`** (new file):

Source-level contract tests (same style as existing contract tests — read source text, assert on patterns):

1. **Extension host has the map**: assert `TaskViewerProvider.ts` contains `_lastDispatchedPlanByTerminal` as a `Map`.
2. **Standalone has the map**: assert `bootstrap.ts` contains `lastDispatchedPlanByTerminal` as a `Map`.
3. **Extension host overrides clearBeforePrompt on plan change**: assert the `_ptyHostVerb` body contains logic that compares `lastPlanId !== planId` and sets `clearBeforePrompt: true`.
4. **Standalone overrides clearBeforePrompt on plan change**: assert the `ptySendPrompt` case body contains the same comparison and override.
5. **Map is cleared on ptyClearTerminal**: assert both hosts delete the map entry on `ptyClearTerminal`.
6. **Map is cleared on ptyClearAllTerminals**: assert both hosts clear the map on `ptyClearAllTerminals`.
7. **Map entry is deleted on ptyCloseTerminal**: assert both hosts delete on close.
8. **Map entry is renamed on ptyRenameTerminal**: assert both hosts rename on rename.
9. **Same-planId dispatch does NOT override clearBeforePrompt**: assert the logic checks `lastPlanId !== planId` (not just `lastPlanId` existence), so a same-plan resend preserves `false`.
10. **First dispatch does NOT override clearBeforePrompt**: assert the logic checks `lastPlanId` existence (no entry → no clear), so a fresh terminal is not redundantly cleared.
11. **Map is deleted on ptyWrite with /clear (extension host)**: assert the extension host deletes the map entry when `ptyWrite` is sent with `data: '/clear'` (mirrors the existing seat-cache-drop logic).

## Verification Plan

### Automated Tests

1. **Run existing contract tests**: `node src/test/proactive-terminal-rest-clear-contract.test.js` and `node src/test/terminal-coder-dispatch-contract.test.js` — must pass after test updates (or without updates if phrases are preserved, as described in §6).
2. **Run new auto-clear contract tests**: `node src/test/host-auto-clear-on-plan-change.test.js` — must pass.
3. **Run route surface tests**: `node src/test/pty-route-surface-contract.test.js` — must pass (the `clearBeforePrompt` honouring tests should be unaffected, as the caller's explicit `false` is still honoured by the injection block; the host override happens later, inside `_ptyHostVerb`).
4. **Run seat-safeguards tests**: `node src/test/seat-safeguards-fleet-prompt-path.test.js` — must pass (the `clearBeforePrompt: true` seat-block bypass is unchanged).
5. **Run prompt delivery tests**: `node src/test/pty-prompt-delivery-framing.test.js` — must pass (framing is unchanged).
6. **TypeScript compilation**: `npx tsc --noEmit` — no new type errors.
7. **Known limitation — parse-based dispatch backstop**: The parse-based dispatch backstop (extension host only, no `dispatch` field) does not participate in auto-clear. This is acceptable because the team-lead dispatch path always uses `dispatch`. If needed in the future, the parse-based path can resolve planId from planFile and participate.
8. **Known limitation — `planId`-empty dispatches**: A dispatch with only `planFile` (no `planId`) does not participate in auto-clear. The `if (planId)` guard skips Map tracking. This is acceptable because the team-lead dispatch path always supplies a `planId`.

## Out of Scope

- DB-backed last-dispatched-plan tracking (in-memory is sufficient — terminals are fresh on restart).
- Auto-clear for the parse-based dispatch backstop (no `dispatch` field).
- Auto-clear for dispatches with only `planFile` (no `planId`).
- Auto-clear for `sendToTerminal` calls (different payload shape, different host path).
- Changes to `clearTerminalContext` beyond the map-delete optimization.
- Changes to the `clearBeforePrompt` config setting or its default.

---

## Implementation Summary

Implemented host-enforced auto-clear on plan change across both hosts. Added `_lastDispatchedPlanByTerminal` Map (extension host class field in TaskViewerProvider.ts, module-level const in bootstrap.ts). On dispatch with a different planId, the host overrides `clearBeforePrompt` to `true` — same-planId resends preserve `false`. Map maintenance covers ptyClearTerminal, ptyClearAllTerminals, ptyCloseTerminal, ptyRenameTerminal, ptyWrite with /clear (extension host), and clearTerminalContext (extension host). Adapted plan §5: skill files were previously deleted and rules inlined into `_buildDrivePrefix` in KanbanProvider.ts, so documentation updates were applied there instead — expanded inlined rules to cover §7 rewrite (mandatory for correctness, Clear at rest always, same-code exception removed, context preserved for same-plan resends only) and §5.6 table rows (seat reported + different plan, keeping context across subtasks). Existing contract test assertions preserved. Created new contract test file `src/test/host-auto-clear-on-plan-change.test.js` with 11 source-level assertions. No compilation or tests run per dispatch directives.

## Review Findings

This plan's `planId` compare and its `_lastDispatchedPlanByTerminal` map were superseded by the atomic-team lifecycle's work-context compare (`featureId ?? planId`) before this review; the planId compare was correctly not restored, but the map survived as **write-only state** — maintained at five lifecycle sites per host and read by no decision, with 11 of the new test file's 15 assertions pinning it in place. Deleted the map from `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts`, and rewrote `src/test/host-auto-clear-on-plan-change.test.js` (21 assertions) onto the live `_lastWorkContextByTerminal` / `_lastWorkContextByTeam` maps plus a guard against the dead map returning. The plan's documented "known limitation — parse-based dispatch backstop does not participate" turned out to be the whole board dispatch path, so the lifecycle is now fed from either identity source, and the destination override was made to honour `terminal.clearBeforePrompt` as the plan's own edge-case table promised. **Validation:** `compile-tests` and `compile` clean, `eslint` 0 errors, and all six contract gates this plan names (`terminal-rest-clear`, `terminal-coder-dispatch`, `host-auto-clear`, `pty-route-surface`, `pty-prompt-delivery-framing`, `seat-safeguards`) are both scripted in `package.json` and invoked by `.github/workflows/integration-tests.yml`. **Remaining risk:** `seat-safeguards-fleet-prompt-path` is 94/3 red — identical at committed HEAD (its `ptyListTerminals`-called-once and 7-call-site audits were both broken by earlier work), so it is a stale audit needing a re-run, not a regression from this plan.
