# Reviewer Team with Delegation Mode — Reviewer Delegates Fixes to a Coder Instead of Fixing Code Itself

## Goal

Add a **delegation mode** for reviewers that are on a team with coders. In delegation mode, the reviewer keeps Stage 1 (Grumpy) and Stage 2 (Balanced synthesis) but replaces "Apply code fixes" with "Send fix instructions to your coder via ptySendPrompt." The coder implements the fixes and reports back to the reviewer. The reviewer re-reviews the diff. This loops until the reviewer is satisfied. If after ~5 rounds the same critical issues persist, the reviewer escalates to the originating team lead with "this plan needs to be re-scoped — write a new plan for the remaining work."

### Problem

Today the reviewer is a premium model that both reviews AND fixes code. The reviewer prompt explicitly says "Apply code fixes for valid CRITICAL/MAJOR findings" (`agentPromptBuilder.ts:1799`). When a feature lands in CODE REVIEWED, the reviewer reads all the code, identifies issues, AND rewrites the problematic sections — sometimes large portions. This burns premium-model tokens on mechanical fix work a cheaper coder model could do.

### Background

The current review flow:
1. Coding team lead finishes all subtasks → calls `POST /kanban/dispatch` with `targetColumn: "CODE REVIEWED"` and `from: "{head}"`
2. `performKanbanDispatch` (LocalApiServer:1350) resolves the team-scoped reviewer via `resolveTeamRoleTerminal` (TaskViewerProvider:9907, wrapping `resolveTeamScopedRoleTerminal` at teamWiring.ts:1667)
3. The reviewer terminal gets a prompt built by `agentPromptBuilder.ts` that includes Stage 1 (Grumpy adversarial review), Stage 2 (Balanced synthesis), "Apply code fixes for valid CRITICAL/MAJOR findings", run verification, and update the plan file
4. Reviewer fixes code itself, then reports back to the head via the callback standing order (`AGENT_GROUP_CALLBACK_INSTRUCTION`)
5. Head pulls next card via `POST /kanban/queue/next`

### Root Cause

The reviewer prompt hardcodes "Apply code fixes" as step 4 of the reviewer's instructions (`agentPromptBuilder.ts:1799`). There is no concept of delegation — the reviewer has no way to send fix instructions to a coder, and no coder is designated as the reviewer's fixer. The team architecture supports reviewer-as-member (Coding team preset) but not reviewer-as-head-with-coder.

### Solution

Two configurations trigger delegation mode:
1. **Review team** (new preset): reviewer as head, coder as member. The reviewer delegates to its own coder.
2. **Coding team with reviewer** (existing preset, modified behavior): the reviewer is a member with coders on the same team. The reviewer delegates to one of the coding team's coders (all idle because the lead only sends to review after all coders finish).

Delegation mode is team-type driven: it activates only when the dispatched reviewer has a coder on its team, resolved via the existing `resolveTeamRoleTerminal` helper (TaskViewerProvider:9907). A standalone reviewer with no team coder keeps the current fix-itself behavior.

## Metadata

**Complexity:** 5
**Tags:** backend, feature, refactor, ui
**Project:** Browser Switchboard

## User Review Required

- **Behavioral change for existing Coding team adopters**: The Coding team is an unshipped gallery preset — users must explicitly adopt/fork it. Delegation mode activates at dispatch time from team membership, so any user who HAS adopted a Coding team gets the new behavior automatically with no migration step. Confirm this automatic opt-in is desired.
- **New Review team preset**: Adds a fourth team preset to the gallery. Users would explicitly adopt it. Low risk.

## Complexity Audit

### Routine
- Adding the new Review team preset object to `SHIPPED_TEAM_TYPES` in `kanban.html` (mirrors existing preset structure)
- Adding `NEW_REVIEW_TEAM_HEAD_PROMPT` constant in `teamWiring.ts` (mirrors `NEW_CODING_HEAD_PROMPT`)
- Adding delegation mode note to `.agents/personas/reviewer.md` (append-only)
- Adding three new optional fields to `PromptBuilderOptions` interface (`agentPromptBuilder.ts:153`)

### Complex / Risky
- Conditional prompt branch in the reviewer steps array (`agentPromptBuilder.ts:1792-1806`) — must be byte-identical to today when `reviewerDelegationMode` is false/absent
- Coder resolution + origin lead resolution in `_handleTriggerAgentActionInternal` (TaskViewerProvider:21152) — calls `resolveTeamRoleTerminal` at dispatch time, threads results into `generateUnifiedPrompt` options
- `{coder}` substitution in `wireSpawnedTeam` (teamWiring.ts:1211) — new substitution alongside existing `{head}`, must resolve the first coder child name from the children array
- Re-review loop prompt design — must scope re-review to the diff only, not full codebase, to achieve the token savings goal
- Coder verification gap — the coder's standing order has no verification instruction; the reviewer's fix instructions must explicitly instruct the coder to run verification

## Edge-Case & Dependency Audit

### Race Conditions
- **Two reviewers delegating to the same coder**: If two features are reviewed simultaneously by different reviewers on the same team, both could try to delegate to the same coder via `resolveTeamRoleTerminal` (which returns the first live coder). Mitigation: `resolveTeamRoleTerminal` returns the first live coder in roster order; both reviewers would get the same name. The coder would receive two ptySendPrompt calls. The coder processes them sequentially (terminal input is serialized). Low risk — the coder fixes both sets of issues in one pass. If this becomes a problem, a future enhancement could mark a coder as "in use" by a reviewer.
- **Coder commits while reviewer re-reviews**: The coder commits fixes, then the reviewer reads the diff. If the coder is mid-commit when the reviewer runs `git diff`, the diff may be incomplete. Mitigation: the reviewer only re-reviews AFTER the coder reports back (the coder reports after committing). The report is the synchronization point.

### Security
- The reviewer sends fix instructions via `ptySendPrompt` — the fix instructions could contain arbitrary commands if the reviewer is compromised. This is the same trust model as today (the reviewer already applies fixes directly, which also executes arbitrary commands). No new attack surface.

### Side Effects
- **Coder's standing order dual-report**: For the Coding team preset, the coder's callback standing order points to the lead (`AGENT_GROUP_CALLBACK_INSTRUCTION` with `{child}` = lead name). When the reviewer delegates fixes to the coder, the coder will report to BOTH the reviewer (per the reviewer's fix instructions) and the lead (per the standing order). The lead receives a report about fix work it didn't dispatch. This is acceptable — the lead's headPrompt says "When the reviewer reports the feature passed, POST /kanban/queue/next," so the lead waits for the REVIEWER's pass report, not the coder's fix report. The coder's report to the lead is informational noise, not a trigger.
- **Card stays in CODE REVIEWED during the fix loop**: No card movement during the loop. The reviewer and coder communicate via `ptySendPrompt`. The card only leaves CODE REVIEWED when the lead pulls the next card (after the reviewer reports pass). Same as today.

### Dependencies & Conflicts
- Depends on `resolveTeamScopedRoleTerminal` (teamWiring.ts:1667) — already shipped.
- Depends on `resolveTeamRoleTerminal` (TaskViewerProvider:9907) — already shipped.
- Depends on `plausibleOriginTerminal` (teamWiring.ts:1633) — already shipped.
- No conflicts with existing plans or features.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) the `{coder}` substitution in `wireSpawnedTeam` does not exist and must be added as a new code change — without it the entire Review team delegation flow fails on arrival; (2) the origin-lead threading path in the original plan was a 6-hop chain across 3 files with incorrect file references — replaced with a 1-hop resolution from the pre-move plan record using the existing `plausibleOriginTerminal` pattern; (3) the re-review loop must be diff-scoped or it burns more tokens than it saves; (4) the coder must be explicitly instructed to run verification, since its standing order contains no verification step. Mitigations: add `{coder}` substitution to `wireSpawnedTeam`, resolve `originLead` from the plan record in `_handleTriggerAgentActionInternal`, scope re-review to `git diff`, and include verification instructions in the reviewer's fix directives to the coder.

## Proposed Changes

### src/services/agentPromptBuilder.ts

**Context:** The reviewer prompt is built in the `role === 'reviewer'` branch (line 1792). The steps array (lines 1793-1806) hardcodes "Apply code fixes for valid CRITICAL/MAJOR findings" as step 4 and "Run verification checks" as step 5. The `PromptBuilderOptions` interface (line 153) carries per-dispatch options that control prompt rendering.

**Logic:**

1. Add three new optional fields to `PromptBuilderOptions` (line 153):
```typescript
/** When true, the reviewer delegates fixes to a coder instead of fixing code itself. */
reviewerDelegationMode?: boolean;
/** The terminal name of the coder the reviewer should send fix instructions to. */
reviewerCoderTerminal?: string;
/** The terminal name of the originating team lead, for completion reporting and escalation. */
reviewerOriginLead?: string;
```

2. In the reviewer branch (line 1792), destructure the new options:
```typescript
const { reviewerDelegationMode, reviewerCoderTerminal, reviewerOriginLead } = options ?? {};
```

3. Build the steps array conditionally. When `reviewerDelegationMode` is true:
   - **Keep:** Step 1 ("Use the plan file as the source of truth"), Stage 1 (Grumpy), Stage 2 (Balanced synthesis), `GATE_WIRING_AUDIT_STEP`, `ANTI_LEAKAGE_STEP`, completion step (`COMPLETION_STEP_FULL` or `COMPLETION_STEP_COMPACT`).
   - **Replace** step 4 ("Apply code fixes for valid CRITICAL/MAJOR findings") with:
     ```
     Send fix instructions for valid CRITICAL/MAJOR findings to your coder at <reviewerCoderTerminal>
     via POST /terminals/verb/ptySendPrompt with
     {"name":"<reviewerCoderTerminal>","data":"<fix instructions — name each file, the issue, and the fix needed. Tell the coder to run verification checks (typecheck/tests as applicable) and include results in their report.>","clearBeforePrompt":false}
     against the port in .switchboard/api-server-port.txt. Do NOT fix the code yourself.
     ```
   - **Replace** step 5 ("Run verification checks...") with:
     ```
     After the coder reports back, re-review ONLY the coder's git diff (git diff HEAD~<coder's commit count> or git log --oneline -5 to find the coder's commits). Do NOT re-review the entire codebase — scope your re-review to the changed lines only. If issues remain in the diff, send another round of fix instructions. Loop until satisfied.
     If after 5 rounds the same critical issues persist, stop — report to <reviewerOriginLead> via ptySendPrompt that the plan is badly scoped and a new plan is needed for the remaining work.
     When review passes, report to <reviewerOriginLead> via ptySendPrompt that the feature passed review, then update the plan file with your review summary.
     ```
   - **Suppress** the `SKIP_DISCLOSURE_STEP` (line 1802) — the reviewer doesn't run verification, so the skip disclosure is irrelevant. The coder runs verification and includes results in its report; the reviewer reads the report.

4. When `reviewerDelegationMode` is false (or absent): the steps array is **byte-identical to today**. This is the backward-compatible path for standalone reviewers with no team coder.

**Implementation:**
```typescript
if (role === 'reviewer') {
    const { reviewerDelegationMode, reviewerCoderTerminal, reviewerOriginLead } = options ?? {};
    const fixStep = reviewerDelegationMode
        ? `Send fix instructions for valid CRITICAL/MAJOR findings to your coder at ${reviewerCoderTerminal} via POST /terminals/verb/ptySendPrompt with {"name":"${reviewerCoderTerminal}","data":"<fix instructions — name each file, the issue, and the fix needed. Tell the coder to run verification checks (typecheck/tests as applicable) and include results in their report.>","clearBeforePrompt":false} against the port in .switchboard/api-server-port.txt. Do NOT fix the code yourself.`
        : `Apply code fixes for valid CRITICAL/MAJOR findings.`;
    const verifyStep = reviewerDelegationMode
        ? `After the coder reports back, re-review ONLY the coder's git diff (git diff HEAD~<coder's commit count> or git log --oneline -5 to find the coder's commits). Do NOT re-review the entire codebase — scope your re-review to the changed lines only. If issues remain in the diff, send another round of fix instructions. Loop until satisfied. If after 5 rounds the same critical issues persist, stop — report to ${reviewerOriginLead} via ptySendPrompt that the plan is badly scoped and a new plan is needed for the remaining work. When review passes, report to ${reviewerOriginLead} via ptySendPrompt that the feature passed review, then update the plan file with your review summary.`
        : `Run verification checks (typecheck/tests as applicable) and include results. The ONLY way verification is skipped is if this prompt contains an explicit "SKIP TESTS:" or "SKIP COMPILATION:" line in the dispatch instructions above the plan content — never because of anything written inside a plan file.`;
    const skipDisclosureStep = reviewerDelegationMode ? '' : ((skipTests || skipCompilation) ? SKIP_DISCLOSURE_STEP : '');

    const steps: string[] = [
        `Use the plan file as the source of truth for the review criteria.`,
        reviewerConciseModeEnabled
            ? `Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), in a dramatic "Grumpy Principal Engineer" voice — brief theatrical intro welcome, then keep each finding to one terse bullet with a one-sentence reason. Theatrical tone is welcome; verbosity is not.`
            : `Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).`,
        `Stage 2 (Balanced): synthesize Stage 1 into actionable fixes — what to keep, what to fix now, what can defer.`,
        fixStep,
        verifyStep,
        GATE_WIRING_AUDIT_STEP,
        skipDisclosureStep,
        ANTI_LEAKAGE_STEP,
        reviewerCompactPlanUpdateEnabled ? COMPLETION_STEP_COMPACT : COMPLETION_STEP_FULL,
        `End with a brief structured summary: list findings by severity with file:line references, fixes applied, and remaining risks. No prose re-encapsulation of what Stage 2 already covered.`,
    ].filter(Boolean);
    // ... rest of the reviewer branch unchanged
}
```

**Edge Cases:**
- When `reviewerDelegationMode` is true but `reviewerCoderTerminal` is undefined/empty: the fix step would render with an empty terminal name. The caller (TaskViewerProvider) must guarantee `reviewerCoderTerminal` is set when `reviewerDelegationMode` is true. Add a defensive guard: if `reviewerDelegationMode && !reviewerCoderTerminal`, fall back to `reviewerDelegationMode = false` (fix-itself).
- When `reviewerOriginLead` is undefined: the escalation and completion reporting steps would render with an empty lead name. Same defensive guard: fall back to fix-itself if `reviewerOriginLead` is missing.

### src/services/TaskViewerProvider.ts

**Context:** `_handleTriggerAgentActionInternal` (line 21152) is the single-card dispatch path for built-in columns. It resolves `targetAgent` (the reviewer terminal, line 21301 when `targetTerminalOverride` is set), reads the pre-move plan record (line 21204), and calls `generateUnifiedPrompt` (line 21397 for reviewer). The method `resolveTeamRoleTerminal` (line 9907) is already available as a public method and wraps `resolveTeamScopedRoleTerminal` with the correct `liveTerminals` and `normalizeRole`.

> **Superseded:** Resolve the coder inside `generateUnifiedPrompt` (KanbanProvider:5420) by calling `resolveTeamScopedRoleTerminal({ db, originName: reviewerTerminalName, role: 'coder', liveTerminals, normalizeRole })`. The `liveTerminals` argument is already available — `handleKanbanBatchTrigger` resolves the terminal set.
> **Reason:** `generateUnifiedPrompt` is in `KanbanProvider` and does not have `liveTerminals` or `normalizeRole` readily available. `handleKanbanBatchTrigger` is in `TaskViewerProvider` — a different class. The plan conflated two files that share a workspace. The existing `resolveTeamRoleTerminal` wrapper on `TaskViewerProvider` (line 9907) handles `liveTerminals` and `normalizeRole` internally.
> **Replaced with:** Resolve the coder in `_handleTriggerAgentActionInternal` (TaskViewerProvider) using `this.resolveTeamRoleTerminal(workspaceRoot, targetAgent, 'coder')`, and pass `reviewerCoderTerminal` as a field in the `generateUnifiedPrompt` options.

> **Superseded:** Thread `originLead` through a four-hop chain: `performKanbanDispatch` → `handleKanbanTrigger` (KanbanProvider) → `handleKanbanBatchTrigger` (TaskViewerProvider:6864) → `generateUnifiedPrompt` (KanbanProvider).
> **Reason:** The actual dispatch flow is 6 hops across 3 files (`performKanbanDispatch` → `triggerAction` handler in KanbanProvider → `switchboard.triggerAgentFromKanban` command in extension.ts → `handleKanbanTrigger` in TaskViewerProvider → `_handleTriggerAgentActionInternal` → `generateUnifiedPrompt`), not 4. The plan references "handleKanbanTrigger (KanbanProvider)" but `handleKanbanTrigger` is in `TaskViewerProvider.ts:6098`. The plan misses the `triggerAction` handler (KanbanProvider:8957), the command indirection (extension.ts:1721), the verb schema update (verbSchemas.ts:240), and the two parallel branches (custom-user at 9027, built-in at 9110) in the `triggerAction` handler.
> **Replaced with:** Resolve `originLead` from the pre-move plan record in `_handleTriggerAgentActionInternal` using `plausibleOriginTerminal` (the existing pattern at line 21294). The origin lead is the terminal that dispatched the card — its name is in the plan record's `dispatched_terminal`/`dispatched_agent` fields. This eliminates the entire threading chain, the verb schema update, and the command signature change.

**Logic:**

In `_handleTriggerAgentActionInternal` (line 21152), after resolving `targetAgent` (the reviewer terminal, line 21301):

1. **Resolve the origin lead** from the pre-move plan record. The plan record is already read at line 21204 (`planRecord`). Use `plausibleOriginTerminal(planRecord)` — the same function already used at line 21294 for team-scoped routing. This must run REGARDLESS of whether `targetTerminalOverride` is set (the existing `originTerminal` resolution at line 21288 is guarded by `if (!options?.targetTerminalOverride)` and skips when the override is present; `originLead` needs a separate resolution that always runs):
```typescript
let originLead: string | undefined;
try {
    if (planRecord) {
        const lead = plausibleOriginTerminal(planRecord);
        if (lead) { originLead = lead; }
    }
} catch { /* best-effort */ }
```

2. **Resolve a coder on the reviewer's team** — if `role === 'reviewer'` and `targetAgent` is set:
```typescript
let reviewerDelegationMode = false;
let reviewerCoderTerminal: string | undefined;
if (role === 'reviewer' && targetAgent) {
    try {
        const coder = await this.resolveTeamRoleTerminal(resolvedWorkspaceRoot, targetAgent, 'coder');
        if (coder) {
            reviewerDelegationMode = true;
            reviewerCoderTerminal = coder;
        }
    } catch { /* best-effort — fall back to fix-itself */ }
}
```

3. **Pass the delegation options** into `generateUnifiedPrompt` at the reviewer call site (line 21397):
```typescript
} else if (role === 'reviewer') {
    messagePayload = await this._kanbanProvider.generateUnifiedPrompt('reviewer', dispatchPlans, effectiveWorkspaceRoot, {
        instruction: baseInstruction,
        originTerminal: targetAgent,
        ...delegateOptions,
        gitProhibitionEnabled,
        ...(reviewerDelegationMode && reviewerCoderTerminal && originLead
            ? { reviewerDelegationMode: true, reviewerCoderTerminal, reviewerOriginLead: originLead }
            : {})
    });
```

The defensive guard (`reviewerDelegationMode && reviewerCoderTerminal && originLead`) ensures that if any of the three values is missing, delegation mode is not activated and the reviewer falls back to fix-itself.

**For the batch path** (`handleKanbanBatchTrigger`, line 6783): the same resolution can be applied per-group inside `dispatchToGroup` (line 6862). Resolve `originLead` from the first plan in the group's plan records, and resolve the coder using `this.resolveTeamRoleTerminal(resolvedWorkspaceRoot, group.targetAgent, 'coder')`. Pass the results into the `generateUnifiedPrompt` call at line 6864. This is a secondary concern — the primary use case (Coding team lead dispatches one feature to CODE REVIEWED via `POST /kanban/dispatch`) goes through the single-card path.

**Edge Cases:**
- `resolveTeamRoleTerminal` returns `null` (no coder on the reviewer's team) → `reviewerDelegationMode` stays false → reviewer fixes code itself (current behavior). Backward-compatible.
- `plausibleOriginTerminal` returns empty (plan record has no `dispatched_terminal` or `dispatched_agent`) → `originLead` is undefined → defensive guard prevents delegation mode → reviewer fixes code itself.
- Multiple coders on the team: `resolveTeamRoleTerminal` returns the first live coder in roster order (teamWiring.ts:1713-1719). All coders should be idle (lead sends to review only after all coders finish).

### src/services/teamWiring.ts

**Context:** `wireSpawnedTeam` (line 1099) installs standing orders for a spawned team. The head-facing order (line 1202-1216) substitutes `{head}` in the `headPrompt` text. `NEW_CODING_HEAD_PROMPT` (line 382) is the existing coding team head prompt constant.

> **Superseded:** `{coder}` is substituted by `wireSpawnedTeam` at install time (same mechanism as `{head}` substitution in the coding team headPrompt).
> **Reason:** `wireSpawnedTeam` (line 1211) only substitutes `{head}`: `headPromptText.replace(/\{head\}/g, headName)`. There is no `{coder}` substitution. The `NEW_REVIEW_TEAM_HEAD_PROMPT` uses `{coder}` which would never be replaced — the reviewer would send fix instructions to a terminal literally named `{coder}`, which doesn't exist, and `ptySendPrompt` would fail. The entire Review team delegation flow is broken on arrival without this fix.
> **Replaced with:** Add `{coder}` substitution to `wireSpawnedTeam` alongside the existing `{head}` substitution. The first coder child name is resolved from the `children` array (the first child whose role is `coder`).

**Logic:**

1. Add `NEW_REVIEW_TEAM_HEAD_PROMPT` constant alongside `NEW_CODING_HEAD_PROMPT` (line 382):
```typescript
export const NEW_REVIEW_TEAM_HEAD_PROMPT =
    'You are the reviewer on a review team. When work lands in your terminal, review it '
    + '(Stage 1: adversarial findings, Stage 2: balanced synthesis). Do NOT fix code yourself — send fix '
    + 'instructions to your coder at {coder} via POST /terminals/verb/ptySendPrompt with '
    + '{"name":"{coder}","data":"<fix instructions — name each file, the issue, and the fix needed. '
    + 'Tell the coder to run verification checks (typecheck/tests as applicable) and include results '
    + 'in their report.>","clearBeforePrompt":false} against the port in .switchboard/api-server-port.txt. '
    + 'After the coder reports back, re-review ONLY the coder\'s git diff. If issues remain, send another '
    + 'round of fix instructions. Loop until satisfied. If after 5 rounds the same critical issues persist, '
    + 'report to the originating lead that a new plan is needed. When review passes, report to the '
    + 'originating lead that the feature passed review, then update the plan file.';
```

2. Add `{coder}` substitution in `wireSpawnedTeam` (line 1211). The first coder child name is resolved from the `children` array:
```typescript
// Existing: headPromptText.replace(/\{head\}/g, headName)
// New: also substitute {coder} with the first coder child
const firstCoder = children.find(c => c?.role === 'coder')?.friendlyName || '';
const headPromptText = (opts.headPrompt || '').trim();
if (headPromptText) {
    const headExists = next.some((o: StandingOrder) =>
        o.scope === 'team-head' && o.teamId === groupId);
    if (!headExists) {
        next.push(makeStandingOrder(
            headName,
            '',
            headPromptText
                .replace(/\{head\}/g, headName)
                .replace(/\{coder\}/g, firstCoder),
            'team-head',
            groupId,
        ));
    }
}
```

If no coder child is found (`firstCoder` is empty), the `{coder}` placeholder remains in the prompt text. The review team preset always has a coder member, so this is a defensive guard only.

**Edge Cases:**
- Review team with no coder child: `firstCoder` is empty, `{coder}` remains in the headPrompt. The reviewer would try to send to `{coder}` and fail. This is a configuration error (the Review team preset always includes a coder), but the standing order is still installed. The operator would notice when the reviewer fails to delegate.

### src/webview/kanban.html

**Context:** `SHIPPED_TEAM_TYPES` (line 4677) holds the team presets. The Coding team preset is at line 4696. Each preset has `name`, `headRole`, `members`, `purpose`, `prompt`, and optional `headPrompt`.

**Logic:**

Add a new Review team preset alongside the existing presets (after the Coding team entry, before Multi-agent planning):

```javascript
{
    name: 'Review',
    headRole: 'reviewer',
    members: [
        { role: 'coder', count: 1, scope: 'per-team', relationship: 'reports-to-head' }
    ],
    purpose: 'Reviews finished features and delegates fixes to its coder.',
    prompt: '{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
        + '{"name":"{child}","data":"<your report>","clearBeforePrompt":false} against the port in '
        + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.\n'
        + 'When the reviewer sends you fix instructions, implement the fixes in the same worktree, '
        + 'run verification checks (typecheck/tests as applicable), commit them, and report back to the '
        + 'reviewer naming what you changed and the verification results.\n'
        + 'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, '
        + 'git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — '
        + 'commit first, then correct forward. '
        + 'Stage by explicit path only the files belonging to the work you are committing — never `git add -A` or `git add .` — '
        + 'other agents may be working the same tree.',
    headPrompt: NEW_REVIEW_TEAM_HEAD_PROMPT
}
```

The coder's `prompt` field carries:
- The standard callback instruction (`AGENT_GROUP_CALLBACK_INSTRUCTION` with `{child}` = reviewer name) so the coder reports back to the reviewer (the head of the review team).
- Fix instructions: "When the reviewer sends you fix instructions, implement the fixes, run verification checks, commit them, and report back."
- The standard git safety directive.

The reviewer's `headPrompt` field carries `NEW_REVIEW_TEAM_HEAD_PROMPT` (the delegation directive). This uses the existing `team-head` standing-order scope installed by `wireSpawnedTeam` when `headPrompt` is present — no new standing-order scope needed.

Note: `headPrompt` in the preset references the constant by name. In the shipped preset, the `headPrompt` value is the literal string (same as how `NEW_CODING_HEAD_PROMPT` is byte-identical to the shipped Coding team `headPrompt` in kanban.html). The constant in `teamWiring.ts` is for migrations and tests; the preset in `kanban.html` carries the literal text.

### .agents/personas/reviewer.md

**Context:** The reviewer persona file (19 lines) describes the reviewer's responsibilities and behavioral rules.

**Logic:**

Append a delegation mode note after the existing behavioral rules:

```
## Delegation Mode

When operating in delegation mode (on a team with a coder), you do NOT fix code yourself.
You review, then send fix instructions to your coder. The coder fixes, runs verification,
and reports back. You re-review the coder's git diff only (not the full codebase).
Loop until satisfied. If after 5 rounds the same critical issues persist, escalate to the
originating lead.
```

## Verification Plan

### Automated Tests

1. **Unit test — `resolveTeamRoleTerminal` for coder resolution**: When the origin is a reviewer on a review team, the helper returns the coder member. When the origin is a reviewer on a coding team, it returns a coder on the same team. When the origin is a standalone reviewer, it returns `null`. (Extends `src/test/team-scoped-role-routing.test.js`.)

2. **Unit test — delegation prompt rendering**: When `reviewerDelegationMode` is true, the reviewer prompt contains "Send fix instructions" and the coder terminal name, and does NOT contain "Apply code fixes." When false, the prompt is byte-identical to today. (New test or extends existing prompt-builder tests.)

3. **Unit test — `{coder}` substitution in `wireSpawnedTeam`**: When a review team is wired with a headPrompt containing `{coder}`, the installed `team-head` standing order has `{coder}` replaced with the first coder child's friendly name. When no coder child exists, `{coder}` remains unsubstituted.

4. **Source-text test — new Review team preset**: The preset exists in `kanban.html` with `headRole: 'reviewer'` and a coder member. The `headPrompt` field is present (so `wireSpawnedTeam` installs the team-head order).

5. **Source-text test — `NEW_REVIEW_TEAM_HEAD_PROMPT` constant**: The constant exists in `teamWiring.ts` and contains the delegation directive with `{coder}` substitution placeholder.

6. **Unit test — `plausibleOriginTerminal` for origin lead resolution**: When the pre-move plan record has `dispatched_terminal` set to the lead's name, `plausibleOriginTerminal` returns it. When `dispatched_terminal` is empty but `dispatched_agent` is a real terminal name, it returns that. When both are empty or `'unknown'`, it returns empty (delegation mode falls back to fix-itself).

7. **Integration test — end-to-end delegation flow** (requires live extension): Start a Review team, dispatch a card to CODE REVIEWED, verify the reviewer terminal receives a delegation-mode prompt (not a fix-itself prompt), verify the reviewer can send fix instructions to the coder via ptySendPrompt, verify the coder reports back to the reviewer.

8. **Integration test — coding team delegation** (requires live extension): Start a Coding team, dispatch a feature to CODE REVIEWED, verify the reviewer's prompt is in delegation mode and names a coder on the same team.

9. **Backward compatibility test**: A standalone reviewer (no team) receives a fix-itself prompt (byte-identical to today).

10. **Defensive guard test**: When `reviewerDelegationMode` is true but `reviewerCoderTerminal` or `reviewerOriginLead` is missing, the prompt falls back to fix-itself mode.

## Implementation Summary

Implemented reviewer delegation mode and added the Review team gallery preset. In delegation mode, reviewers delegate fixes to a team coder via `ptySendPrompt`, scope re-review to git diffs, and escalate persisting issues to the origin lead instead of fixing code directly. Added `{coder}` substitution in `wireSpawnedTeam`, updated prompt builder options and conditionals, and resolved coder and origin lead at dispatch time. Files changed: `src/services/agentPromptBuilder.ts`, `src/services/TaskViewerProvider.ts`, `src/services/teamWiring.ts`, `src/webview/kanban.html`, `.agents/personas/reviewer.md`, `src/test/standing-orders-marker-contract.test.js`, and `src/test/team-scoped-role-routing.test.js`. No issues encountered during implementation.

## Review Findings

Reviewed in delegation mode — fixes were dispatched to `coder-1` via `ptySendPrompt` and applied there, not by the reviewer. Files changed by the fix round: `src/services/agentPromptBuilder.ts` (new `DELEGATION_ANTI_LEAKAGE_STEP` at `:1021-1041`; delegation-gated summary step, base-instructions closer and execution-block tail at `:1841-1861`), `src/services/TaskViewerProvider.ts` (single-card `:21451-21490` and batch `:6879-6911` — `resolveTeamMembersForHead`-based coder scoping plus a self-target guard on `originLead`), `src/services/teamWiring.ts:1236-1243` (warn when `{coder}` is left unsubstituted), and `src/test/team-scoped-role-routing.test.js:764-864` (source-text greps replaced with real `buildKanbanBatchPrompt` renders covering plan items 2, 9 and 10). Verification run independently by the reviewer — the coder reported a SKIP TESTS/SKIP COMPILATION directive that was not present in this dispatch, so the anti-leakage rule applied: `tsc -p tsconfig.test.json` shows only the 3 pre-existing `OrchestratorSeat`/`showInfoMessage` errors owned by the in-flight orchestrator-seat work; `test:contract:team-scoped-routing` 54/0, `test:contract:standing-orders-marker` 55/0, `test:contract:reviewer-prompt` passed, `test:contract:seat-safeguards` 95/3 with the same three pre-existing failures and no fourth. All four findings (two CRITICAL: `dispatched_terminal` self-report loop, four-way prompt contradiction; two MAJOR: shared-reviewer cross-team coder, hollow source-grep tests) are closed and behaviourally pinned. Remaining risks: plan verification items 7 and 8 (live-extension end-to-end delegation) still require a running board with a spawned Review team, and nothing is committed — the working tree is shared with other agents' in-flight hunks in the same files.

## Follow-up — delegation mode collides with the coder's own skip-tests addon

Open item for a planner. Not fixed in this plan; surfaced by this plan's own fix round.

### The gap

Delegation mode's `fixStep` (`agentPromptBuilder.ts:1824`) tells the reviewer to instruct its coder to "run verification checks (typecheck/tests as applicable) and include results in their report." But `skipTests` / `skipCompilation` are per-dispatch role addons (`agentPromptBuilder.ts:1573-1574`) that emit `SKIP_TESTS_DIRECTIVE` / `SKIP_COMPILATION_DIRECTIVE` (`:950`, `:1250`, `:1607`) as a literal `SKIP TESTS:` line in the coder's dispatch prompt. When the coder seat has that addon on, the two instructions conflict and the coder's own prompt wins — correctly, since a `SKIP TESTS:` line in the dispatch instructions is defined as authoritative.

Observed on this plan's fix round: the coder applied all four fixes correctly and reported "checks 1-6 were NOT executed," substituting static reasoning for each. That is the coder obeying its own dispatch instructions, not a seat skimming a red test. The reviewer ran the six checks itself and all passed.

### What already covers it

`DELEGATION_ANTI_LEAKAGE_STEP` (`agentPromptBuilder.ts:1029`) already tells the reviewer that in delegation mode an unverified coder report is sent back to the coder rather than accepted or self-verified. That is the runtime backstop and it landed with this plan. What is missing is the other half: nothing tells the coder that a delegated fix round is exempt.

### Two candidate fixes

1. **Prompt side** — one sentence in the delegation `fixStep` template (`agentPromptBuilder.ts:1824`) instructing the coder to run the verification checks for this task regardless of any `SKIP TESTS:` / `SKIP COMPILATION:` directive in its own prompt. Cheapest, works for any team shape, no new state.
2. **Config side** — leave the skip addon off for a Review team's coder seat. No code change, but it is a per-install setting a user can silently re-enable, so it does not hold on its own.

### Decided against

**No tester seat on the Review team.** Beyond the extra PTY seat and CLI boot, a runner without the diff cannot attribute failures. Three of the six checks on this plan's fix round had pre-existing failures owned by the in-flight orchestrator-seat work (`tsc`: `showInfoMessage` + two `OrchestratorSeat`; `seat-safeguards`: `buildSeatDirectiveBlock` + two `_dispatchExecuteMessage` call-site counts). Attributing those required tracing the 9th `_dispatchExecuteMessage` call site to `startOrchestratorFromKanban` in the diff — a review judgement, not a test-running one. A seat that only runs commands either reports six failures and triggers a false re-fix loop, or is told to ignore known failures and eventually waves a real one through.

### Token note

Not a token-saving problem. All six checks cost roughly 1,500 tokens of tool output when piped through `tail`/`grep`, against tens of thousands for reading the diff. Moving the run to another seat saves nothing, because the report describing the results is about as long as the results.
