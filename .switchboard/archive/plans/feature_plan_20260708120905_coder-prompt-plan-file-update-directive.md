# Feature Plan: Add Plan-File Update Directive to All Coding Roles

## Goal

### Problem
The "stop kanban card status light when plan is updated" feature doesn't work for coding agents. The mechanism relies on the agent editing the plan file after completing work — the file watcher (`GlobalPlanWatcherService.ts`) detects the mtime advance and clears the working-state light. However, **none of the three coding roles** (lead, coder, intern) have any instruction to write anything back to the plan file. The agent completes work, never touches the plan .md file, and the status light stays on forever.

### Background
- The activity-light-clears-on-plan-edit mechanism is in `src/services/GlobalPlanWatcherService.ts` lines 836–854:
  ```typescript
  if (updatedRecord.dispatchedAt) {
      await db.clearWorkingState(relativePath, workspaceId);
      updatedRecord.dispatchedAt = null;
  }
  ```
  It fires on any mtime advance of the plan file while `dispatchedAt` is set. The comment at lines 836–841 confirms: "the dispatch flow does not write the plan file (updateDispatchInfoByPlanFile only runs SQL), so any mtime advance reaching here while dispatched_at is set is the agent's completion edit. No agent-authored text is trusted."
- The `**Stage Complete:**` marker system (`STAGE_COMPLETE_LABEL` at `agentPromptBuilder.ts` line 520, parsed by `planMetadataUtils.ts` lines 125–136) is **vestigial** — the interface comment at line 287 states: "the activity-light OFF-switch is now mtime-based (see GlobalPlanWatcherService), so no directive consumes this field." The watcher does NOT reference `stageComplete` at all; the clear is purely mtime-driven.
- The **reviewer prompt** (`agentPromptBuilder.ts` lines 970–977) DOES instruct: "Update the original plan file with fixed items, files changed, validation results, and remaining risks."
- The three coding roles each have **separate prompt branches** with their own base variables:
  - **`lead`** (lines 1112–1153) — uses `leadBase` (line 1118), returns at line 1152
  - **`coder`** (lines 1155–1242) — uses `coderBase` in two sub-paths: feature-mode (line 1169) and non-feature-mode (line 1209)
  - **`intern`** (lines 1244–1280) — uses `internBase` (line 1245), returns at line 1279
- None of `leadBase`, `coderBase`, or `internBase` contain a plan-file update instruction.
- The watcher works correctly — the gap is purely in the prompts.

### Root Cause
All three coding-role prompt branches lack a directive to edit the plan file upon completion. Without a plan-file edit, the mtime-based watcher never fires, and the working-state light never clears for any coding-role-dispatched card.

## Metadata

- **Tags:** backend, bugfix
- **Complexity:** 3

## User Review Required

No user review required. This is a prompt-text addition with no data migrations, no schema changes, and no new user-facing configuration. The directive is unconditional (always emitted for coding roles) and mirrors the existing reviewer plan-file update instruction. Verify via manual dispatch checks listed in the Verification Plan.

## Complexity Audit

### Routine
- Adding a shared directive string constant for the plan-file update, placed alongside the other role-directive constants (`FOCUS_DIRECTIVE`, `CAVEMAN_OUTPUT_DIRECTIVE`, `SUPPRESS_WALKTHROUGH_DIRECTIVE` at lines 501–570).
- Appending the directive to `baseInstructions` (after `resolveBaseInstructions`) in `leadBase` (lead branch), `coderBase` (both coder sub-paths), and `internBase` (intern branch). This matches the established `CAVEMAN_OUTPUT_DIRECTIVE` append pattern already used in all four locations.

### Complex / Risky
- None. The change is a single-string-constant plus four unconditional one-line appends, all in one file. No architectural change, no new patterns, no data-consistency risk.

## Edge-Case & Dependency Audit

### Race Conditions
- The watcher fires on mtime advance. If the agent edits the plan file multiple times, the first edit clears the light — subsequent edits are no-ops (`dispatchedAt` is already null). Safe.

### Security
- None.

### Side Effects
- Coding agents will now append a short summary to the plan file. This is useful documentation and triggers the status-light clear. The plan file grows slightly but this is acceptable.
- The watcher will clear the working state on the first edit. If the agent is still working but edits the plan file mid-task (e.g. to note progress), the light clears early. This is an acceptable trade-off — the user asked for "a short summary" and the mechanism is mtime-based by design.
- **Phone-a-Friend coexistence:** All three coding roles already receive a `PHONE_A_FRIEND_DIRECTIVE` (line 498) in their `promptParts` when `phoneAFriendEnabled` is set. That directive instructs the agent to POST an HTTP notification to `/phone-a-friend` on completion. The new `CODING_COMPLETION_REPORT_DIRECTIVE` instructs the agent to edit the plan file on completion. These are **complementary, not conflicting**: the Phone-a-Friend POST notifies a separate agent process; the plan-file edit triggers the mtime watcher to clear the working-state light. Both fire at completion, neither interferes with the other. The agent performs both actions independently.

### Dependencies & Conflicts
- Must be consistent with the reviewer's plan-file update instruction (lines 970–977). Use similar wording but shorter (the user said "All it takes is a short summary").
- Must cover all three coding roles (lead, coder, intern) — they have separate branches and separate `*Base` variables.
- **Override survival:** The directive must be appended to `baseInstructions` AFTER `resolveBaseInstructions` returns, not to `*Base` before it. `resolveBaseInstructions` (line 291) supports a `'replace'` override mode (line 300: `base = override.text`) that would wipe any content appended to `*Base` before the call. Appending after the call — matching the `CAVEMAN_OUTPUT_DIRECTIVE` pattern at lines 1128, 1176, 1216, 1252 — guarantees the directive survives all override modes.

## Dependencies

No dependencies on other plans or sessions. This is a self-contained single-file prompt-text change.

## Adversarial Synthesis

Key risks: (1) appending the directive before `resolveBaseInstructions` would let a `'replace'` override silently wipe it — mitigated by appending to `baseInstructions` after the call, matching the established caveman pattern; (2) the constant was originally placed at line 207 (inside the options interface) instead of the directive-constant gallery at ~line 570 — corrected; (3) the Phone-a-Friend directive already exists in all coding prompts — confirmed complementary, not conflicting. Net risk is very low: a routine, single-file, four-line-append change with no data or architectural impact.

## Proposed Changes

---

### 1. `src/services/agentPromptBuilder.ts` — Add shared plan-file update directive constant

**Context**: The directive constants live at lines 401–574 (`GIT_SAFETY_DIRECTIVE`, `PHONE_A_FRIEND_DIRECTIVE`, `FOCUS_DIRECTIVE`, `REMOTE_MODE_DIRECTIVE`, `STAGE_COMPLETE_LABEL`, `ADVISE_RESEARCH_DIRECTIVE`, `CAVEMAN_OUTPUT_DIRECTIVE`, `SUPPRESS_WALKTHROUGH_DIRECTIVE`). Add the new constant near `SUPPRESS_WALKTHROUGH_DIRECTIVE` (after line 570), NOT at line 207 — line 207 is `clearAntigravityContext?: boolean` inside the `BuildKanbanBatchPromptOptions` interface, not a directive-constant location.

**Implementation**:
```typescript
// Add after SUPPRESS_WALKTHROUGH_DIRECTIVE (line 570), alongside the other role-directive constants:
export const CODING_COMPLETION_REPORT_DIRECTIVE = `COMPLETION REPORT: When you have finished implementing the plan, append a brief summary (3-5 sentences) to the END of the original plan file. Include: what you implemented, files changed, and any issues encountered. This edit signals task completion to the kanban board — the file watcher detects it and clears the card's working-state light. Do NOT skip this step.`;
```

---

### 2. `src/services/agentPromptBuilder.ts` — Append directive to lead prompt

**Context**: Lines 1112–1153, the `lead` branch. The `leadBase` is assembled at line 1118–1124. `baseInstructions` is resolved at line 1126 (`resolveBaseInstructions('lead', leadBase, options)`). The `CAVEMAN_OUTPUT_DIRECTIVE` is appended conditionally at lines 1127–1129.

**Implementation**: Append the completion-report directive to `baseInstructions` AFTER the caveman conditional (after line 1129), unconditionally:
```typescript
// After the caveman conditional block (after line 1129), before focusBlock (line 1133):
baseInstructions += '\n\n' + CODING_COMPLETION_REPORT_DIRECTIVE;
```

**Why after `resolveBaseInstructions`, not before**: `resolveBaseInstructions` (line 291) supports `'replace'` override mode (line 300) that sets `base = override.text`, wiping any pre-call append to `leadBase`. Appending to `baseInstructions` after the call guarantees the directive survives all override modes. This matches the established `CAVEMAN_OUTPUT_DIRECTIVE` pattern at line 1128.

---

### 3. `src/services/agentPromptBuilder.ts` — Append directive to coder prompt (feature mode)

**Context**: Lines 1161–1200, the feature-mode coder branch. The `coderBase` is set at line 1169. `baseInstructions` is resolved at line 1174 (`resolveBaseInstructions('coder', coderBase, options)`). The `CAVEMAN_OUTPUT_DIRECTIVE` is appended conditionally at lines 1175–1177.

**Implementation**: Append after the caveman conditional (after line 1177), unconditionally:
```typescript
// After the caveman conditional block (after line 1177), before gitBlock (line 1182):
baseInstructions += '\n\n' + CODING_COMPLETION_REPORT_DIRECTIVE;
```

---

### 4. `src/services/agentPromptBuilder.ts` — Append directive to coder prompt (non-feature mode)

**Context**: Lines 1202–1242, the non-feature coder branch. The `coderBase` is set at line 1209. `baseInstructions` is resolved at line 1214 (`resolveBaseInstructions('coder', coderBase, options)`). The `CAVEMAN_OUTPUT_DIRECTIVE` is appended conditionally at lines 1215–1217.

**Implementation**: Append after the caveman conditional (after line 1217), unconditionally:
```typescript
// After the caveman conditional block (after line 1217), before focusBlock (line 1221):
baseInstructions += '\n\n' + CODING_COMPLETION_REPORT_DIRECTIVE;
```

---

### 5. `src/services/agentPromptBuilder.ts` — Append directive to intern prompt

**Context**: Lines 1244–1280, the `intern` branch. The `internBase` is assembled at line 1245–1248. `baseInstructions` is resolved at line 1250 (`resolveBaseInstructions('intern', internBase, options)`). The `CAVEMAN_OUTPUT_DIRECTIVE` is appended conditionally at lines 1251–1253.

**Implementation**: Append after the caveman conditional (after line 1253), unconditionally:
```typescript
// After the caveman conditional block (after line 1253), before safeguardsBlock (line 1258):
baseInstructions += '\n\n' + CODING_COMPLETION_REPORT_DIRECTIVE;
```

---

### 6. Build artefact

`dist/extension.js` is a build artefact, not source. Per project rules, `dist/` is not the source of truth and is not audited or flagged during reviews. The extension is tested via an installed VSIX. No manual `dist/` edit is needed or tracked.

## Verification Plan

### Manual Verification
- [ ] Dispatch a card to the **coder** role — verify the generated prompt contains the COMPLETION REPORT directive
- [ ] Dispatch a card to the **lead** role — verify the generated prompt contains the COMPLETION REPORT directive
- [ ] Dispatch a card to the **intern** role — verify the generated prompt contains the COMPLETION REPORT directive
- [ ] Dispatch a feature-mode coder card — verify the feature-mode prompt also contains the directive
- [ ] After any coding agent completes work and edits the plan file, verify the kanban card's working-state light clears
- [ ] Verify the plan file has a brief summary appended at the end
- [ ] Verify the reviewer prompt's plan-file update instruction is still present (no regression)
- [ ] Verify that a `defaultPromptOverrides` `'replace'` override for a coding role does NOT wipe the completion-report directive (it survives because it is appended after `resolveBaseInstructions`)

### Automated Tests
- `npm run build` succeeds — **SKIPPED per session directive (skip compilation)**
- `npm test` passes — **SKIPPED per session directive (skip tests)**
- Add tests: `buildKanbanBatchPrompt('coder', ...)` output includes 'COMPLETION REPORT'
- Add tests: `buildKanbanBatchPrompt('lead', ...)` output includes 'COMPLETION REPORT'
- Add tests: `buildKanbanBatchPrompt('intern', ...)` output includes 'COMPLETION REPORT'

## Files Changed

- `src/services/agentPromptBuilder.ts` — new `CODING_COMPLETION_REPORT_DIRECTIVE` constant (~line 570) + unconditional append to `baseInstructions` after `resolveBaseInstructions` in lead (line ~1130), coder feature-mode (line ~1178), coder non-feature (line ~1218), and intern (line ~1254) branches

## Recommendation

Complexity 3 (routine, single-file, four one-line appends + one constant). **Send to Coder.**

## Review Findings

Files changed: `src/services/agentPromptBuilder.ts` — new `CODING_COMPLETION_REPORT_DIRECTIVE` (line 572) + unconditional appends in lead (1142), coder feature-mode (1194), coder non-feature (1238), and intern (1276). Validation (read/grep; compile+tests skipped per directive): all four appends land after `resolveBaseInstructions` and after the caveman conditional, so a `'replace'` override cannot wipe them; no signature/return change (zero caller impact), nothing removed (no orphaned refs), and the watcher clears on first mtime advance (repeat edits are no-ops, no double-trigger). Reviewer plan-file instruction (line 988) intact. No CRITICAL/MAJOR findings; no code fixes required. Remaining risk (NIT): the directive says "the original plan file" (singular) while feature-mode coder runs N subtasks — mitigated by `STAGGERED_IMPLEMENTATION_DIRECTIVE`, which explicitly requires the per-plan report on each subtask's own file when staggering is on.

**Second-pass review (2026-07-09):** Re-verified all four append sites in `agentPromptBuilder.ts` (lead 1142, coder-feature 1194, coder-nonfeature 1238, intern 1276) — each lands after `resolveBaseInstructions` and after the caveman conditional, so a `'replace'` override cannot wipe them; `analyst`/`planner`/`reviewer` correctly excluded. Regression trace confirmed no caller impact (no signature/return change), no orphaned refs, and no double-trigger/race (watcher clears on first mtime advance, repeats are no-ops). Findings limited to two NITs (singular-file wording, hand-copied appends); no CRITICAL/MAJOR, no fixes applied. Compile/tests skipped per session directive.

**Third-pass review (2026-07-09, regression-traced):** Re-confirmed via source read: constant at line 572; four appends at lead 1142, coder-feature 1194, coder-nonfeature 1238, intern 1276 — each immediately after `resolveBaseInstructions` and after the `if (cavemanOutputEnabled)` block, so a `'replace'` override (line 306 sets `base` *inside* the fn, before return) cannot wipe them. Exactly 5 identifier occurrences (1 decl + 4 appends); planner/reviewer/tester/analyst/researcher/chat correctly excluded. No signature/return change → zero caller impact; nothing removed → no orphaned refs; watcher clears on first mtime advance → no double-trigger. No CRITICAL/MAJOR, no code fixes.
