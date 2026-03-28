# Refine Chat Workflow for Pure Ideation

The [chat.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agent/workflows/chat.md) workflow currently contains triggers that cause premature delegation to external agents. This plan removes those triggers and aligns the workflow with the current project architecture (which favors the Kanban UI over legacy handoff).

## Proposed Changes

### Workflows

#### [MODIFY] [chat.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agent/workflows/chat.md)

1. **Remove Governance Rule 28**: Delete the "immediately pivot to a handoff workflow" instruction. This is the primary source of premature mode-switching.
2. **Update Transition Steps (21-23)**:
   - Change from "Proceed to /handoff" to "Suggest creating a plan or manually moving to the next stage in the Kanban Sidebar."
   - Emphasize that `/chat` should only end when the user signals they are done with ideation.
3. **Clarify Mode Purpose**: Add a note that `/chat` is for high-fidelity technical discussion and requirements gathering, not for implementation.

## Verification Plan

### Manual Verification
1. Activate `/chat` mode.
2. Mention a "revision" or "fix" without an explicit implement command.
3. Verify that the agent stays in `PLANNING` mode and continues the discussion.
4. Verify the agent only suggests a plan/move once the ideation is obviously complete.

## Complexity Audit
**Manual Complexity Override:** Low

### Complex / Risky
- None.

---

## Reviewer Pass Results
**Date:** 2026-03-27 | **Verdict:** ✅ PASS — No issues found

### Adversarial Critique
- Verified `chat.md` no longer contains premature delegation triggers (`/handoff`, `send_message`, `delegate_task`).
- The workflow correctly stays in PLANNING mode, using only `notify_user` for output.
- No residual action-oriented language that could confuse agents into executing.

### Changes Applied
None required — implementation matches plan exactly.

### Verification
- `npx tsc --noEmit` — clean (0 errors)
- Manual inspection of `.agent/workflows/chat.md` — confirmed compliant
