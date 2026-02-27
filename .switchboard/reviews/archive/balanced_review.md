# Balanced Review: Resilience Fixes Plan

**Target:** `.switchboard/plans/features/resilience_fixes_20260218.md`
**Reviewer Persona:** Lead Developer & Mediator

---

## Summary of Review

The resilience fixes plan correctly identifies real UX pain points — workflow locks, routing confusion, and path validation errors have been recurring for a week. However, the proposed solutions over-engineer the fixes. The actual codebase already has most of the safety mechanisms. The real gap is in **prompt instructions and workflow definitions**, not in the runtime engine.

---

## Valid Concerns from Grumpy

### 1. Auto-Stop Already Exists (CRITICAL-2) ✅ Accepted
`force: true` already does exactly what the plan proposes. The fix is to update `.agent/workflows/switchboard.md` to instruct agents to use `start_workflow(force: true)` by default when entering from a slash command. This is a **prompt fix**, not a code fix.

### 2. Smart Routing is Dangerous (CRITICAL-3) ✅ Accepted
Auto-correcting action verbs silently changes intent. `delegate_task` and `execute` have fundamentally different persistence and side-effect models. We should NOT auto-map between them. Instead, the error message should be improved to say: *"Action 'delegate_task' is not valid for workflow 'phonefriend'. Valid actions: ['execute']. Did you mean action: 'execute'?"*

### 3. Path Safety is Out of Scope (MAJOR-1) ✅ Accepted
The `IsArtifact` flag is validated by the host toolchain, not our MCP server. We can only fix this at the **prompt level** by making workflow instructions explicit about file ownership.

### 4. Root Cause is Prompt Failure (CRITICAL-4) ✅ Partially Accepted
The system IS working correctly — the guards caught every error. But "the system is correct" doesn't mean the UX is good. Users shouldn't need to debug MCP internals. We need to make the error messages more actionable AND update prompts to prevent agents from hitting them.

---

## Action Plan

### Priority 1: Prompt-Level Fixes (Low Risk, High Impact)
1. **Update `switchboard.md`**: Add instruction to always use `start_workflow(force: true)` when invoked via slash command.
2. **Update `phonefriend.md`**: Add explicit note: "This workflow uses `action: 'execute'`, NOT `delegate_task`."
3. **Update all workflow `.md` files**: Add `IsArtifact: false` instruction for `.switchboard/` file creation.
4. **Add a "Quick Reference" section** to each workflow `.md` listing the valid `send_message` action(s).

### Priority 2: Better Error Messages (Low Risk, Medium Impact)
5. **Improve `WORKFLOW LOCK` message**: Add suggestion: "Tip: Use `force: true` to auto-replace the stale workflow."
6. **Improve routing rejection message**: Include the list of valid actions for the current workflow, e.g., "Valid actions for 'phonefriend': ['execute']."
7. **Improve `PHASE-GATE BLOCKED` message**: Include what phase needs completion and what evidence is expected.

### Priority 3: Test Coverage (Medium Risk, Medium Impact)
8. **Add test for `--all` phase-gate bypass** (NIT-1 from Grumpy).
9. **Add test for routing rejection message quality** — assert error contains valid actions list.

---

## Dismissed Points

### "Auto-Stop as Default" — Dismissed
Making force the *default* is too aggressive. The lock exists to prevent accidental workflow clobbering. The fix is to make agents *use* force when appropriate via prompt guidance, not to remove the safety net.

### "Path Safety at Tool Level" — Dismissed
Out of our control. Prompt guidance is the correct layer for this fix. If a future version of the host toolchain adds path-aware artifact detection, great — but we can't wait for that.

---

## Final Verdict

**The plan needs a major pivot.** Instead of 3 code-level features, the fix is:
- **4 prompt edits** (Priority 1)
- **3 error message improvements** (Priority 2)  
- **2 new tests** (Priority 3)

Total effort: ~30 minutes of prompt editing + ~1 hour of error message + test work. No architectural changes needed.
