# Relax No Eager Context Behavioral Constraints

## Goal
Relax the "No Eager Context" constraint across agent workflows and persona guidelines to prevent agents from pedantically refusing to read files that the user mentions unless a strict "directive verb" (like "review" or "read") is used. The goal is to allow agents to read any files the user names or references in the chat while still ignoring the automatically injected active editors metadata. Additionally, fold the now-redundant `switchboard_operator.md` persona file into the chat workflow to eliminate a duplicate file-read on every `/switchboard-chat` invocation, and add it to the extension's blocklist so it cannot be re-scaffolded.

## Metadata
**Tags:** workflow, documentation
**Complexity:** 5

## User Review Required
> [!NOTE]
> This change modifies the core `.agent/` instructions and deletes a persona file. Once applied, agents will be more proactive in reading files that you mention or point to, but will still ignore workspace files that are merely open in your active editors. The `switchboard_operator.md` persona file will be deleted and its content folded into the chat workflow — no rules are lost, only the redundant file-read is eliminated.

## Complexity Audit
### Routine
- Modify `.agent/workflows/switchboard-chat.md` line 12 to remove the strict "directive verb" requirement from the NO EAGER CONTEXT constraint header.
- Modify `.agent/workflows/switchboard-chat.md` line 22 to relax rule #9 (No Eager Context Adoption) in the Switchboard Operator Persona rules.
- Delete `.agent/personas/switchboard_operator.md` — all 9 rules are already duplicated verbatim in the workflow file's inline constraints section.
- Add `.agent/personas/switchboard_operator.md` to the extension blocklist in `src/extension.ts` (line ~2795) to prevent re-scaffolding on extension activation.
- Add `.agent/personas/switchboard_operator.md` to the blocklist in `src/services/ControlPlaneMigrationService.ts` `_copyDirectoryRecursive` flow (or equivalent guard) to prevent re-scaffolding during control-plane migration.
- Add `DEFAULT_CHAT_BASE_INSTRUCTIONS` constant to `agentPromptBuilder.ts` containing the inline chat workflow rules.
- Add `chat` role branch to `buildKanbanBatchPrompt` in `agentPromptBuilder.ts`.
- Replace hardcoded prompt strings in `chatCopyPrompt` and `copyChatWorkflow` handlers in `KanbanProvider.ts` with calls to `buildKanbanBatchPrompt('chat', ...)`.

### Complex / Risky
- The `.agent/` directory is gitignored (`.git/info/exclude` line 10: `.agent/*`). The persona file is not tracked by git — it exists on disk only because the extension's activation scaffolding (extension.ts lines 2758-2786) copies it from the installed extension's bundled `.agent/` directory. Every time the extension activates or setup runs, the file is re-created if it doesn't exist. Deleting it from disk without adding it to the blocklist is futile — it will be re-scaffolded on next activation. The blocklist is the only effective fix.
- **Dual source of truth**: The chat workflow rules will now exist in two places — `.agent/workflows/switchboard-chat.md` (read by agents who invoke `/switchboard-chat` directly) and `DEFAULT_CHAT_BASE_INSTRUCTIONS` in `agentPromptBuilder.ts` (used by the copy-prompt buttons). Changes to one must be mirrored to the other. This is an inherent risk of inlining workflow content into code. Mitigation: a code comment on the constant explicitly states the dependency. The workflow file remains the authoritative source for agents that read it directly; the constant is the authoritative source for clipboard prompts.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. These are static markdown files and a one-time TypeScript blocklist addition with no runtime behavior.
- **Security:** None. Reading a file the user mentions does not expose any additional attack surface — the agent already had read access; it was just refusing to use it.
- **Side Effects:**
  - If a user mentions a file that doesn't exist, the agent will now attempt to read it and produce an error instead of asking "did you want me to read that?" first. This is a minor UX change but arguably better — the agent confirms the file doesn't exist rather than ignoring the reference.
  - If a user mentions a file hypothetically (e.g., "I don't want to change `foo.ts`"), the agent may read it for context. The plan considers this a positive side effect for context accuracy, and the agent still won't modify the file without permission.
  - Deleting the persona file eliminates one file-read tool call per `/switchboard-chat` invocation, reducing latency.
- **Dependencies & Conflicts:**
  - The `accuracy.md` workflow has no "No Eager Context" rule — it already mandates aggressive file reading via "Deep Context Gathering" (Step 2). No change needed there.
  - No other persona files (coder, intern, lead_coder, gatherer, etc.) contain the eager context rule.
  - No TypeScript source code references `switchboard_operator` — verified via grep. The persona file is only consumed by agents reading it at runtime.
  - The `ControlPlaneMigrationService._mergeSharedAgentContent` method (line ~807) collects persona files from repos and copies them to the parent `.agent/personas/` directory. If a child workspace still has `switchboard_operator.md`, it could be re-introduced during multi-repo migration. The blocklist addition must cover both the extension activation path and the control-plane migration path.
  - A previous consolidation (brain plan `brain_a3728d3b...`) already folded the persona into the workflow and deleted the file from disk, but it was re-scaffolded by the extension on next activation because the blocklist was not updated. This plan must close that loop by adding the blocklist entry.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) "Implicitly references" is subjective and may cause agents to over-read on ambiguous mentions; (2) non-existent file references will produce read errors instead of clarification prompts; (3) the persona file may re-appear if the blocklist is incomplete or a new scaffolding path is added later; (4) the chat workflow rules now exist in two places (workflow file + TypeScript constant), creating a dual-source-of-truth drift risk. Mitigations: the replacement text provides concrete anchoring examples that constrain interpretation; the non-existent file error is more informative than silent refusal; the blocklist covers both known scaffolding paths; the dual-source risk is mitigated by an explicit code comment and the fact that the workflow file changes rarely.

## Proposed Changes

### Part 1: Relax No Eager Context Rule

#### [MODIFY] [.agent/workflows/switchboard-chat.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agent/workflows/switchboard-chat.md)
Relax the "No Eager Context" constraint in the chat workflow definition. Two locations in the same file.

##### Context
Line 12 is the standalone `NO EAGER CONTEXT` constraint header. Line 22 is rule #9 under the Switchboard Operator Persona rules section. Both express the same policy and must be updated for consistency.

##### Changes:
```diff
-12: - **NO EAGER CONTEXT**: Discard any active documents injected by the IDE metadata. Only read files if explicitly named and directed by the user (e.g., "review this file").
+12: - **NO EAGER CONTEXT**: Discard automatically injected active documents from the IDE metadata. However, if the user references, mentions, or points to any file (e.g., "in kanban.html..." or "look at cleanWorkspace.ts"), you are expected and allowed to read it immediately.
```
```diff
-22:     9. **No Eager Context Adoption**: When initializing a new plan, discard any active documents injected by the IDE. Only read a file's contents if the user's current message explicitly names the file path AND uses a directive verb (e.g., "review", "read", "use", "apply").
+22:     9. **No Eager Context Adoption**: When initializing a new plan, discard active documents automatically injected by the IDE. However, if the user explicitly or implicitly references a file path in their message, you are expected and allowed to read its contents immediately (e.g., "look at file X", "in file Y this needs changing", etc.) without requiring a specific directive verb.
```

##### Edge Cases
- If the user mentions a file hypothetically ("don't touch X"), the agent may read it for context but will not modify it without permission — this is acceptable and improves context accuracy.
- If the user mentions a non-existent file, the agent will attempt the read and receive a file-not-found error, which is more informative than silently ignoring the reference.

### Part 2: Fold Persona into Workflow and Prevent Re-Scaffolding

#### [DELETE] [.agent/personas/switchboard_operator.md](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agent/personas/switchboard_operator.md)

##### Context
The `switchboard_operator.md` persona file contains 9 rules that are already duplicated verbatim in `switchboard-chat.md` lines 14-22 (the "Switchboard Operator Persona & Rules" inline section). The workflow file's Step 1 already says "Adopt the consolidated Switchboard Operator rules listed in the Constraints section above" — it does not reference the persona file.

**Why the file keeps coming back:** The `.agent/` directory is gitignored (`.git/info/exclude`). The persona file is not tracked by git — it exists on disk only because the extension's activation scaffolding copies it from the installed extension's bundled `.agent/` directory. A previous consolidation attempt (brain plan `brain_a3728d3b...`) deleted the file from disk, but the extension re-created it on next activation because the blocklist was not updated. Deleting the file without the blocklist is futile.

All 9 rules from the persona are preserved in the workflow. The only unique content in the persona file is the title/goal statement ("You are the Switchboard Operator & Systems Analyst. Goal: De-risk implementation through rigorous requirements gathering and modular orchestration.") — this is already implied by the workflow's description and Step 1, but if desired it can be added as a one-line header above the inline rules in the workflow.

##### Changes:
Delete the file. No content migration needed — all rules already exist inline in the workflow.

#### [MODIFY] [src/extension.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts)
Add `switchboard_operator.md` to the extension activation blocklist to prevent re-scaffolding.

##### Context
Lines 2794-2809 define a blocklist of `.agent/` files that are deleted after the copy-from-bundled-directory step. The persona file must be added here so that even if the bundled extension still contains it, it won't be re-created in the workspace.

##### Changes:
```diff
 // 2b. Blocklist: remove files that should never be distributed even if present in source
 const blocklist = [
     '.agent/rules/no_git_for_agents.md',
     '.agent/rules/switchboard_modes.md',
     '.agent/workflows/handoff.md',
     '.agent/workflows/handoff-chat.md',
     '.agent/workflows/handoff-lead.md',
     '.agent/workflows/handoff-relay.md',
     '.agent/workflows/challenge.md',
+    '.agent/personas/switchboard_operator.md',
 ];
```

#### [MODIFY] [src/services/ControlPlaneMigrationService.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/ControlPlaneMigrationService.ts)
Add a guard in the control-plane migration path to skip `switchboard_operator.md` during shared agent content merging.

##### Context
The `_mergeSharedAgentContent` method (line ~797) collects persona files from child repos and copies them to the parent `.agent/personas/` directory. If any child workspace still has `switchboard_operator.md`, it could be re-introduced during multi-repo migration. The simplest fix is to add the same blocklist entry to the migration service, or filter it out in `_collectSharedAgentEntries`.

The most maintainable approach is to add a `CONSOLIDATED_PERSONAS` constant (or reuse the existing blocklist pattern) and filter those files out during `_collectSharedAgentEntries` or `_copySharedFile`.

##### Changes:
Add a filter in `_mergeSharedAgentContent` to skip `switchboard_operator.md`:
```diff
 const sharedEntries = await this._collectSharedAgentEntries(repos, ['personas', 'workflows', 'skills']);
 
+// Skip persona files that have been consolidated into workflows
+const consolidatedPersonas = new Set(['personas/switchboard_operator.md']);
 for (const [relativePath, entries] of sharedEntries.entries()) {
+    if (consolidatedPersonas.has(relativePath)) continue;
     const uniqueHashes = new Set(entries.map((entry) => entry.hash));
```

##### Edge Cases
- If a child workspace has a customized `switchboard_operator.md` (different from the bundled version), the merge logic would have skipped it anyway due to hash mismatch (`uniqueHashes.size > 1`). The consolidated filter just makes the skip explicit and permanent.
- The `_bootstrapControlPlaneLayout` method also copies from the bundled `.agent/` directory via `_copyDirectoryRecursive` with `overwrite: false`. Since the persona file will be deleted from the workspace, the next bootstrap would re-create it. The blocklist in `extension.ts` handles the activation path, but `_bootstrapControlPlaneLayout` does not currently consult a blocklist. The safest fix is to also add the persona to the bundled source directory's exclusion list, or add a post-copy cleanup step. For now, the `extension.ts` blocklist covers the primary activation path; the `_bootstrapControlPlaneLayout` path is only called during explicit user-initiated migration/setup, which is less frequent and can be addressed in a follow-up if needed.

### Part 3: Generate Chat Prompt Inline via Prompt Builder

The chat prompt copy buttons (`chatCopyPrompt` and `copyChatWorkflow` in `KanbanProvider.ts`) currently hardcode a string telling the agent to read `.agent/workflows/switchboard-chat.md`. This has two problems:

1. **Control-plane bug**: The path is relative to the workspace root. In control-plane mode, the agent scoped to a child workspace cannot find the file at the parent's `.agent/` path. Unlike the planner/coder/etc. workflow paths (which are user-configurable fields the user can fix), the chat path is hardcoded in TypeScript and the user cannot easily change it.
2. **Redundant file-read**: The prompt tells the agent to read a file, forcing an extra tool call. Other roles get their instructions inlined by the prompt builder — the chat role should too.

The fix: add a `chat` role to `agentPromptBuilder.ts` that generates the full chat prompt inline (the workflow constraints, steps, and governance rules), just like the planner role inlines its base instructions. The `KanbanProvider.ts` handlers then call the prompt builder instead of constructing a hardcoded string.

#### [MODIFY] [src/services/agentPromptBuilder.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentPromptBuilder.ts)
Add a `chat` role to the prompt builder that generates the Switchboard Chat workflow inline.

##### Context
The `buildKanbanBatchPrompt` function handles roles like `planner`, `reviewer`, `coder`, etc., each with their own base instructions. The `chat` role does not exist yet. It should generate the full Switchboard Chat workflow content inline so the agent receives the instructions directly in the prompt — no file-read required.

The chat workflow content is stable and relatively short (~37 lines). It should be defined as a `DEFAULT_CHAT_BASE_INSTRUCTIONS` constant (matching the pattern of `DEFAULT_REVIEWER_BASE_INSTRUCTIONS`), containing the critical constraints, persona rules, steps, and governance from `switchboard-chat.md`.

##### Changes:
1. Add `DEFAULT_CHAT_BASE_INSTRUCTIONS` constant containing the inline chat workflow rules. This must be kept in sync with `.agent/workflows/switchboard-chat.md` — any changes to the workflow file must also be reflected here. A code comment should note this dependency.

2. Add a `chat` branch in `buildKanbanBatchPrompt` (after the existing role branches, before the `throw` for unknown roles):

```typescript
if (role === 'chat') {
    const chatBase = DEFAULT_CHAT_BASE_INSTRUCTIONS;
    let baseInstructions = resolveBaseInstructions('chat', chatBase, options);

    const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
    const suffixBlock = [dispatchContextPrefix, focusBlock, antigravityBlock]
        .filter(Boolean)
        .join('\n\n');

    let chatPrompt = baseInstructions;
    if (suffixBlock) {
        chatPrompt += '\n\n' + suffixBlock;
    }
    chatPrompt += `\n\nPLANS TO DISCUSS:\n${planList}`;

    return normalizeNewlines(chatPrompt);
}
```

3. Add `'chat'` to the `columnToPromptRole` function if a kanban column maps to it, or leave it as a standalone role invoked only by the chat buttons.

##### Edge Cases
- The chat role doesn't have an execution directive (it's consultation-only, no code execution). The `AUTHORIZATION TO EXECUTE` block must NOT be included — the chat prompt is explicitly non-implementation.
- The `workflowFilePathEnabled` / `workflowFilePath` options should be ignored for the chat role — the instructions are already inlined, so there's no file to read.
- Plan list: the chat prompt uses "PLANS TO DISCUSS" instead of "PLANS TO PROCESS" to reflect the consultation nature.

#### [MODIFY] [src/services/KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)
Replace the hardcoded chat prompt strings with calls to the prompt builder.

##### Context
Two handlers construct chat prompts:
- `chatCopyPrompt` (line 5211): includes plan references for selected cards
- `copyChatWorkflow` (line 5239): bare dispatch prompt without plan references

Both hardcode `Please enter the chat workflow defined at: .agent/workflows/switchboard-chat.md`. This should be replaced by calling `buildKanbanBatchPrompt('chat', plans, options)` which generates the full inline prompt.

##### Changes:

**`chatCopyPrompt` handler (line 5211–5237):**
Replace the hardcoded prompt construction with a call to the prompt builder. The selected cards are already available — convert them to `BatchPromptPlan[]` and pass them to `buildKanbanBatchPrompt('chat', ...)`.

```typescript
case 'chatCopyPrompt': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }

    let chatPlans: BatchPromptPlan[] = [];
    if (Array.isArray(msg.sessionIds) && msg.sessionIds.length > 0) {
        const selectedCards = this._lastCards.filter(card =>
            card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
        );
        chatPlans = selectedCards.map(card => ({
            topic: card.topic,
            absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
            sessionId: card.sessionId,
        }));
    }

    const prompt = buildKanbanBatchPrompt('chat', chatPlans, { workspaceRoot });
    await vscode.env.clipboard.writeText(prompt);
    const count = chatPlans.length;
    const planWord = count > 0 ? ` for ${count} plan(s)` : '';
    vscode.window.showInformationMessage(`Chat prompt copied to clipboard${planWord}.`);
    break;
}
```

**`copyChatWorkflow` handler (line 5239–5247):**
Replace with the same prompt builder call but with an empty plans array (no cards selected):

```typescript
case 'copyChatWorkflow': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) { break; }

    const prompt = buildKanbanBatchPrompt('chat', [], { workspaceRoot });
    await vscode.env.clipboard.writeText(prompt);
    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: 'Copied Switchboard Chat workflow prompt to clipboard.', isError: false });
    break;
}
```

##### Edge Cases
- Empty plan list: the prompt builder should handle `plans.length === 0` gracefully — the "PLANS TO DISCUSS" section is simply omitted or shows "No specific plans selected. Begin general consultation."
- The `workspaceRoot` option is passed so the prompt builder can include workspace-type detection (single-repo vs multi-repo) in the prompt, matching the planner role's behavior.

## Verification Plan
### Automated Tests
- None for the markdown changes. The blocklist addition in `extension.ts` should be verified by checking that the existing `agent-version-migration.test.js` or `control-plane-migration.test.js` still passes.
- The `chat` role in `buildKanbanBatchPrompt` should be covered by a unit test in `agentPromptBuilder.test.ts` verifying: (a) the prompt contains the chat workflow constraints, (b) no "Read .agent/workflows/..." instruction appears, (c) empty plan list produces a valid consultation prompt, (d) non-empty plan list includes "PLANS TO DISCUSS" section.

### Manual Verification
1. **Primary scenario**: Start a new `/switchboard-chat` session and refer to a file implicitly (e.g., *"in cleanWorkspace.ts there are some lines to clean"*). Confirm the agent reads the file directly without asking for an explicit directive verb.
2. **Hypothetical mention**: Mention a file you do NOT want changed (e.g., *"don't modify config.yaml"*). Confirm the agent reads it for context but does not modify it.
3. **Non-existent file**: Reference a file that doesn't exist (e.g., *"look at nonexistent.ts"*). Confirm the agent attempts the read and reports the file-not-found error rather than silently ignoring the reference.
4. **IDE context still ignored**: Open multiple files in the editor, then start a chat session without mentioning any files. Confirm the agent does NOT read any of the open editor files — the IDE-injected context is still discarded.
5. **Directive verb still works**: Use an explicit directive (e.g., *"review cleanWorkspace.ts"*). Confirm the agent reads the file — the old behavior is not broken, only the new behavior is added.
6. **Persona file deleted**: Confirm `.agent/personas/switchboard_operator.md` no longer exists on disk.
7. **No re-scaffolding**: Run the Switchboard Setup command (or reload the extension). Confirm `switchboard_operator.md` is NOT re-created in `.agent/personas/`.
8. **All 9 rules preserved**: Read `.agent/workflows/switchboard-chat.md` and confirm all 9 Switchboard Operator rules are present in the inline constraints section with no omissions.
9. **Chat prompt is self-contained**: Click the "Copy switchboard-chat workflow to clipboard" button. Paste the result. Confirm it contains the full workflow instructions inline — no "Read .agent/workflows/switchboard-chat.md" instruction appears.
10. **Chat prompt with plans**: Select one or more kanban cards, then click the chat copy-prompt button. Confirm the pasted prompt includes both the inline workflow instructions and a "PLANS TO DISCUSS" section listing the selected plans.
11. **Chat prompt without plans**: Click the chat workflow button with no cards selected. Confirm the pasted prompt contains the inline workflow instructions and a general consultation opening (no "PLANS TO DISCUSS" section or a "No specific plans selected" note).

## Recommendation
Complexity 5 → **Send to Coder**

---

## Review Results (2026-06-03)

### Stage 1: Adversarial Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **CRITICAL** | `_bootstrapControlPlaneLayout` in `ControlPlaneMigrationService.ts` copies from the bundled `.agent/` directory via `_copyDirectoryRecursive` with no blocklist. The persona file will be re-scaffolded on every migration/setup call, exactly the same bug the plan claims to close. The plan's own Edge-Case section acknowledged this but deferred it — the deferral was incorrect. |
| 2 | **MAJOR** | `resolveBaseInstructions` (line 158) prepends `Read <workflowFilePath>` for all non-planner roles. The chat role is not excluded, so if `workflowFilePathEnabled` is set, the chat prompt gets a redundant "Read switchboard-chat.md" instruction prepended to the already-inlined content — the exact redundancy this plan was supposed to eliminate. The plan's Edge Cases (line 178) explicitly states these options "should be ignored for the chat role." |
| 3 | NIT→OK | `DEFAULT_CHAT_BASE_INSTRUCTIONS` content fidelity vs. workflow file — markdown bold/heading markers stripped for prompt format, but all 9 rules, constraints, steps, and governance are present with identical text. Acceptable. |
| 4 | NIT | `columnToPromptRole` does not include `chat` — correct per plan's "or leave it as a standalone role" option. |
| 5 | NIT | Empty plan list wording: "None. General consultation." vs plan's suggested "No specific plans selected. Begin general consultation." — implementation's version is more concise and acceptable. |

### Stage 2: Balanced Synthesis

- **Finding 1 (CRITICAL) → Fix now**: Added `AGENT_COPY_BLOCKLIST` static readonly field to `ControlPlaneMigrationService` and a skip check in `_copyDirectoryRecursive`. This closes the re-scaffolding loop for both the migration path and the activation path.
- **Finding 2 (MAJOR) → Fix now**: Added `role !== 'chat'` to the exclusion condition in `resolveBaseInstructions` alongside the existing `role !== 'planner'` check. One-line fix with prevents redundant workflow-file-read prepend.
- Findings 3-5: Keep as-is.

### Code Fixes Applied

#### Fix 1: `src/services/ControlPlaneMigrationService.ts`
- Added `AGENT_COPY_BLOCKLIST` static readonly `Set<string>` containing `'personas/switchboard_operator.md'`
- Added blocklist check in `_copyDirectoryRecursive` before the overwrite/exist checks: `if (this.AGENT_COPY_BLOCKLIST.has(entryRelativePath)) continue;`
- This ensures the persona file is never copied from the bundled `.agent/` directory during `_bootstrapControlPlaneLayout`, closing the re-scaffolding loop that the plan's own Complexity Audit identified.

#### Fix 2: `src/services/agentPromptBuilder.ts`
- Changed `resolveBaseInstructions` condition from `role !== 'planner'` to `role !== 'planner' && role !== 'chat'`
- Added explanatory comment: "Chat role is excluded because its instructions are already inlined via DEFAULT_CHAT_BASE_INSTRUCTIONS."
- This prevents a redundant "Read .agent/workflows/switchboard-chat.md" instruction from being prepended to the already-inlined chat prompt.

### Verification

- **TypeScript type check**: `npx tsc --noEmit` — 3 pre-existing errors, none in modified code. Fixes compile cleanly.
- **Compilation**: Skipped per review instructions.
- **Tests**: Skipped per review instructions.

### Files Changed by Review

| File | Change |
|------|--------|
| `src/services/ControlPlaneMigrationService.ts` | Added `AGENT_COPY_BLOCKLIST` constant and skip check in `_copyDirectoryRecursive` |
| `src/services/agentPromptBuilder.ts` | Added `role !== 'chat'` exclusion in `resolveBaseInstructions` |

### Remaining Risks

1. **Dual-source-of-truth drift**: `DEFAULT_CHAT_BASE_INSTRUCTIONS` in `agentPromptBuilder.ts` must be kept in sync with `.agent/workflows/switchboard-chat.md`. The code comment on the constant notes this dependency. If the workflow file is updated, the constant must be updated too. No automated sync mechanism exists.
2. **Future blocklist additions**: If additional persona files are consolidated into workflows in the future, they must be added to both `extension.ts` blocklist AND `ControlPlaneMigrationService.AGENT_COPY_BLOCKLIST`. Consider extracting a shared constant in a future refactor.
3. **Bundled extension source**: The persona file may still exist in the bundled extension's `.agent/` directory. The blocklist prevents it from being copied to workspaces, but the source file remains. A future cleanup could remove it from the bundled source entirely.
