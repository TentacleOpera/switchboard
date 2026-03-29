# Fix AGENTS.md references to deprecated handoff workflows

## Goal
Remove references to deprecated handoff workflows from AGENTS.md to prevent agents from incorrectly attempting to use delegation for tasks that should be handled directly.

## Metadata
**Tags:** documentation, bugfix
**Complexity:** Low

## Background
The AGENTS.md file currently contains extensive references to `/handoff`, `/handoff-chat`, `/handoff-relay`, and `/handoff-lead` workflows in the Workflow Registry, Code-Level Enforcement table, and Architecture diagram. These workflows are deprecated, but the protocol document still directs agents to use them, causing confusion.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Complete implementation with exact markdown edits.

### Target File: `/Users/patrickvuleta/Documents/GitHub/switchboard/AGENTS.md`

#### [MODIFY] Workflow Registry Table (lines 15-24)

**Context:** The Workflow Registry table lists all available workflow commands. Lines 17-20 reference deprecated handoff workflows that should be removed.

**Logic:** Delete the 4 deprecated handoff workflow rows while preserving the active workflows (`/accuracy`, `/improve-plan`, `/challenge`, `/chat`).

**Implementation:**

**OLD (lines 15-24):**
```markdown
| Trigger Words | Workflow File | Description |
| :--- | :--- | :--- |
| `/handoff`, `/handoff --all`, `handoff --all` | **`handoff.md`** | Default terminal delegation workflow. Optional `--all` only. |
| `/handoff-chat`, `/handoff chat`, `handoff-chat`, `handoff chat` | **`handoff-chat.md`** | Clipboard/chat delegation workflow. Optional `--all` only. |
| `/handoff-relay`, `/handoff relay`, `handoff-relay`, `handoff relay` | **`handoff-relay.md`** | Relay workflow: execute complex work now, stage remainder, then pause for model switch. |
| `/handoff-lead`, `/handoff lead`, `handoff-lead`, `handoff lead` | **`handoff-lead.md`** | Lead Coder one-shot execution workflow for large feature requests. |
| `/accuracy` | **`accuracy.md`** | High accuracy mode with self-review (Standard Protocol). |
| `/improve-plan` | **`improve-plan.md`** | Deep planning, dependency checks, and adversarial review. |
| `/challenge`, `/challenge --self` | **`challenge.md`** | Internal adversarial review workflow (no delegation). |
| `/chat` | **`chat.md`** | Activate chat consultation workflow. |
```

**NEW:**
```markdown
| Trigger Words | Workflow File | Description |
| :--- | :--- | :--- |
| `/accuracy` | **`accuracy.md`** | High accuracy mode with self-review (Standard Protocol). |
| `/improve-plan` | **`improve-plan.md`** | Deep planning, dependency checks, and adversarial review. |
| `/challenge`, `/challenge --self` | **`challenge.md`** | Internal adversarial review workflow (no delegation). |
| `/chat` | **`chat.md`** | Activate chat consultation workflow. |
```

**Edge Cases Handled:** Agents will no longer attempt to invoke deprecated handoff commands.

#### [MODIFY] Code-Level Enforcement Table (lines 46-56)

**Context:** This table documents which MCP tool actions require active workflows. Lines 52-53 reference deprecated handoff workflows.

**Logic:** Remove the `execute` and `delegate_task` rows entirely, as these actions are no longer supported.

**Implementation:**

**OLD (lines 50-56):**
```markdown
| Action | Required Active Workflow |
| :--- | :--- |
| `execute` | `handoff`, `improve-plan`, or `handoff-lead` |
| `delegate_task` | `handoff` |
| `submit_result` | *(no restriction — this is a response)* |
| `status_update` | *(no restriction — informational)* |
```

**NEW:**
```markdown
| Action | Required Active Workflow |
| :--- | :--- |
| `submit_result` | *(no restriction — this is a response)* |
| `status_update` | *(no restriction — informational)* |
```

**Edge Cases Handled:** Clarifies that only `submit_result` and `status_update` are valid actions.

#### [MODIFY] Switchboard Global Architecture Diagram (lines 59-72)

**Context:** The ASCII diagram shows workflow routing. Lines 66-67 reference deprecated handoff workflows.

**Logic:** Remove handoff workflow references and update to reflect Kanban-based workflow.

**Implementation:**

**OLD (lines 61-72):**
```markdown
User ──► Switchboard Operator (chat.md)
              │  Plans captured in .switchboard/plans/
              │
              ├──► /improve-plan   Deep planning, dependency checks, and adversarial review
              ├──► /handoff-lead   One-shot Lead Coder execution (large features)
              ├──► /handoff --all  Bulk terminal delegation (small features)

All file writes to .switchboard/ MUST use IsArtifact: false.
All inter-agent completion signals use the yield pattern (NO POLLING).
All CLI terminal payloads MUST be a single line: "Please execute the plan at: [ABSOLUTE PATH]"
```

**NEW:**
```markdown
User ──► Switchboard Operator (chat.md)
              │  Plans captured in .switchboard/plans/
              │
              ├──► /improve-plan   Deep planning, dependency checks, and adversarial review
              └──► Kanban Board    Plans moved through workflow stages (Created → Coded → Reviewed → Done)

All file writes to .switchboard/ MUST use IsArtifact: false.
Plans are executed via Kanban board workflow, not delegation.
```

**Edge Cases Handled:** Clarifies the new Kanban-based execution model.

#### [DELETE] Timeout & Completion Section (lines 76-81)

**Context:** This section describes timeout behavior for delegated workflows, which no longer exist.

**Logic:** Remove the entire section.

**Implementation:**

**DELETE (lines 76-81):**
```markdown
### ⏱️ Timeout & Completion

- **Initial wait**: 120 seconds before first check-in.
- **Hard timeout**: 600 seconds (10 minutes). On timeout: call `stop_workflow(reason: "<agent> timed out")`.
- **Do not advance** to the next phase without the required artifact or result.
- **Completion** is yield-based: ask the user to confirm when the delegate is done. Do not poll.
```

#### [DELETE] Delegate Prompt Requirements Section (lines 83-91)

**Context:** This section describes how to construct delegated prompts, which are no longer used.

**Logic:** Remove the entire section.

**Implementation:**

**DELETE (lines 83-91):**
```markdown
### 📋 Delegate Prompt Requirements

Every delegated prompt MUST include:
1. Objective and scope
2. Files/artifacts to read/write
3. Verification commands
4. Completion protocol: delegate stops and waits; lead resumes only after explicit user confirmation

**Safety**: Never leak private planning paths (`brain/`, private `task.md`) to delegates. Stage sharable artifacts into `.switchboard/handoff/`.
```

## Edge-Case & Dependency Audit
- **Race Conditions:** None. Documentation-only changes.
- **Security:** None. No code execution or data handling.
- **Side Effects:** Agents will no longer see handoff workflow references in their system prompt. This is the intended behavior.
- **Dependencies & Conflicts:** No conflicts. This is a cleanup task removing deprecated documentation.

## Adversarial Synthesis

### Grumpy Critique
"So you're removing workflow references from AGENTS.md but leaving the actual workflow files in `.agent/workflows/`? Won't agents just find them via file search and use them anyway? And if the workflows are truly deprecated, why not delete the files entirely instead of playing whack-a-mole with documentation? Also, what about existing plans that already reference these workflows—are you going to rewrite all of those too?"

### Balanced Response
The actual problem: AGENTS.md is injected into every agent's system prompt, so listing deprecated workflows there causes agents to **auto-recommend them in every conversation**. Removing them from AGENTS.md stops this behavior. If a user explicitly wants to invoke a deprecated workflow (e.g., by typing `/handoff`), they still can—the workflow files remain in `.agent/workflows/`. This is intentional: we're removing the **auto-suggestion**, not the capability. Existing plans that reference handoff workflows will continue to work; we're not breaking backward compatibility. The workflow files themselves can be deprecated/removed in a separate cleanup task if needed.

## Verification Plan

### Manual Verification
1. **Read AGENTS.md** and verify:
   - Workflow Registry table has exactly 4 rows (accuracy, improve-plan, challenge, chat)
   - No references to `/handoff`, `/handoff-chat`, `/handoff-relay`, or `/handoff-lead`
   - Code-Level Enforcement table has only 2 rows (submit_result, status_update)
   - Architecture diagram mentions "Kanban Board" instead of handoff workflows
   - Timeout & Completion section is deleted
   - Delegate Prompt Requirements section is deleted

2. **Check for orphaned workflow files:**
   - Run: `ls -la .agent/workflows/ | grep handoff`
   - If files exist, recommend deletion in a separate plan (out of scope for this task)

3. **Search for references in other files:**
   - Run: `grep -r "handoff" .agent/ .switchboard/ --exclude-dir=.git`
   - Document any findings for future cleanup

### Build Verification
- No build step required (documentation-only changes)

## Agent Recommendation
**Send to Coder** — This is a routine documentation cleanup task with no complex logic.

## Complexity Audit
**Manual Complexity Override:** Low

### Routine
- Remove 4 rows from Workflow Registry table (lines 17-20)
- Remove 2 rows from Code-Level Enforcement table (lines 52-53)
- Update architecture diagram text (lines 61-72)
- Remove or update Timeout & Completion section (lines 76-81)
- Remove or update Delegate Prompt Requirements section (lines 83-91)

### Complex / Risky
- None

## Reviewer Pass — 2026-03-29

### Findings Summary

| ID | Severity | File:Line | Finding | Resolution |
|:---|:---------|:----------|:--------|:-----------|
| R1 | MAJOR | AGENTS.md:9 | Rule #2 still referenced deprecated actions `execute`, `delegate_task`, and phantom action `request_review`. Contradicted the cleaned-up enforcement table. | Rewrote Rule #2 to reference only valid actions (`submit_result`, `status_update`) and point to the enforcement table. |
| R2 | MAJOR | AGENTS.md:40 | Rule #4 example cited `request_review` — an action that never existed in the codebase (`InboxWatcher.ts` defines only `execute`, `delegate_task`, `submit_result`, `status_update`). | Removed the stale parenthetical example. |
| R3 | NIT | .agent/workflows/ | Four orphaned handoff workflow files remain (`handoff.md`, `handoff-chat.md`, `handoff-relay.md`, `handoff-lead.md`). | Out of scope per plan. Recommend separate cleanup task. |
| R4 | NIT | src/extension.ts:3280 | Extension custom-instruction template still references `delegate_task` and `execute` in MCP tool descriptions. | Out of scope — source code change, separate task. |

### Files Changed

- `AGENTS.md` — Rule #2 rewritten (line 9), Rule #4 example removed (line 40). All plan-specified changes (registry table, enforcement table, architecture diagram, deleted sections) verified correct.

### Validation Results

- `grep -i 'handoff\|delegate_task\|request_review\|handoff-lead\|handoff-chat\|handoff-relay' AGENTS.md` → **0 matches** ✅
- Workflow Registry table: **4 rows** (accuracy, improve-plan, challenge, chat) ✅
- Code-Level Enforcement table: **2 rows** (submit_result, status_update) ✅
- Architecture diagram: **Kanban Board** reference present, no handoff references ✅
- Timeout & Completion section: **deleted** ✅
- Delegate Prompt Requirements section: **deleted** ✅
- Markdown structure: valid, no broken tables or unclosed fences ✅

### Remaining Risks

1. **Orphaned workflow files** (`.agent/workflows/handoff*.md`) could still be discovered by agents via file search. Low risk since AGENTS.md no longer advertises them.
2. **Extension template drift** — `src/extension.ts` custom-instruction blocks still mention `execute`/`delegate_task` in MCP tool descriptions. Future scaffolding runs could re-inject stale references into target workspaces. Recommend a follow-up plan.
3. **No TS source changes** — the code-level enforcement in `InboxWatcher.ts` still gates `execute`/`delegate_task` behind workflow auth. This is correct behavior (defense-in-depth) even though AGENTS.md no longer documents it.
