# Grumpy Critique: Resilience Fixes Plan

**Target:** `.switchboard/plans/features/resilience_fixes_20260218.md`
**Reviewer Persona:** Principal Engineer (Adversarial)

---

## CRITICAL-1: The Plan Doesn't Match the Actual Code Architecture

The plan says: "Modify start_workflow logic in `src/mcp-server/tools/start_workflow.js`".

**That file doesn't exist.** The start_workflow handler lives *inside* `src/mcp-server/register-tools.js` at line ~1400. This is a 2700-line monolith. The plan author didn't even read the codebase before writing the plan.

**Impact:** Any implementer following this plan will waste time searching for non-existent files.

---

## CRITICAL-2: "Auto-Stop" Already Exists — It's Called `force: true`

The plan proposes building an "Auto-Stop" mechanism. **This already exists.** Line 1433 of `register-tools.js`:
```js
if (force === true) {
    forcedStopWorkflow = activeAfterStaleCleanup;
    target.node.activeWorkflow = null;
    // ...
}
```

The *actual* problem is that the **workflow prompt instructions** (`switchboard.md`) don't tell agents to use `force: true`. The fix is a **one-line prompt edit**, not a code change. The plan is proposing engineering work to solve a prompt problem.

---

## CRITICAL-3: "Smart Routing" Proposal Violates the Security Model

The `WORKFLOW_ACTION_ROUTING` map (L49-82) is an **intentional security boundary**. `phonefriend` only allows `execute` (L69-71), *not* `delegate_task`. This is by design — `delegate_task` creates inbox items that persist and trigger standby agents, while `execute` is a direct terminal injection.

The plan proposes auto-correcting `delegate_task` → `execute`. These are **semantically different operations** with different side effects:
- `delegate_task` → writes to `.switchboard/inbox/`, sets dispatch metadata, triggers standby polling
- `execute` → injects directly into terminal stdin

Auto-mapping between them silently changes the agent's intent. This is a **security hole** — an agent could accidentally trigger standby execution thinking it was just dispatching a review.

---

## CRITICAL-4: The Real Problem is Never Addressed

The plan treats symptoms, not root causes. Every failure in today's session was the same root cause: **the agent (me) didn't follow the workflow instructions**.

1. Lock error → I didn't use `force: true` (already available)
2. Routing error → I used `delegate_task` instead of `execute` (phonefriend.md clearly says `execute`)
3. Phase-gate error → I skipped `complete_workflow_phase(phase: 1)` (workflow definition clearly requires it)

The plan proposes building *system-level bypasses* for what are fundamentally *prompt-level failures*. The system is working correctly. The agent is not.

---

## MAJOR-1: "Path Safety" Fix is Out of Scope

The `IsArtifact` validation is part of the **host tool chain** (Windsurf/Cascade), not this plugin. The MCP server has zero control over how `write_to_file` validates paths. The plan is proposing to modify a tool the plugin doesn't own.

**Fix:** Update workflow instructions to explicitly say "Use `IsArtifact: false` for `.switchboard/` files."

---

## MAJOR-2: No Consideration for the `autoplan` Safety Block

Line 1427-1431 shows a special `WORKFLOW SAFETY BLOCK` for autoplan that **prevents force-stopping even with `force: true`**. If the plan's "Auto-Stop" defaulted to force, it would need to handle this special case — but the plan doesn't mention it at all.

---

## NIT-1: Missing Test for the `--all` Phase-Gate Bypass

Line 709 shows that `metadata.all` bypasses the phase-gate check. No test covers this. If we're touching this area, we should add coverage.

---

## NIT-2: Plan Proposes Tests That Already Exist

Test 1 in the verification plan ("Start workflow A, then Start workflow B, assert no lock error") already exists in `workflow-controls.test.js` line 82 — "start_workflow force=true replaces active workflow".
