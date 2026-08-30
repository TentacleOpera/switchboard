# Batch-to-team-head allocate prompt lacks dispatch means (roster, API port, pty recipe)

## Goal

A batch move to a team head now tells the lead to dispatch to seats, but it is handed none of the means to do so. The `_buildFeatureDirectivePrefix` function — which builds the enriched drive-mode operational block (team roster, API port, ptySendPrompt recipe, per-subtask completion POST) — is gated on `plans.some(p => p.isFeature)` (KanbanProvider.ts:6394).

In the batch-to-team-head path (line 6342–6366), `batchOptions.featureMode = true` and `batchOptions.driveMode = true` are set, but the plans are all loose (no `isFeature` flag). So when execution reaches line 6394:

```typescript
if (plans.some(p => p.isFeature) && ['lead', 'coder', 'intern'].includes(role)) {
    const prefix = await this._buildFeatureDirectivePrefix(workspaceRoot, await resolveDrive(), plans);
```

...the condition is `false` (no plan has `isFeature`), and the drive prefix — containing the YOUR TEAM roster, the API port, the ptySendPrompt recipe, and the per-subtask completion POST instructions — is never prepended. The lead receives a batch prompt that says "dispatch to your team seats" but has no idea who the seats are, how to reach them, or how to report completion.

The existing `_buildDrivePrefix` cannot be reused verbatim for the batch path because it is feature-file-centric: it references the feature file's Team Dispatch Instructions section and explicitly forbids opening individual plan files, which a batch lead must do (each plan is independent).

**Root cause:** The batch-to-team-head path sets `featureMode = true` to reuse the feature prompt template, but the drive prefix prepend at line 6394 checks the actual plan data (`p.isFeature`), not the `batchOptions.featureMode` flag. The two signals diverge for the batch case.

## Metadata

**Complexity:** 6
**Tags:** backend, bugfix
**Project:** Browser Switchboard

## User Review Required

No user decision needed. The fix is a mechanical gate correction plus a batch-specific prefix builder. The design choice (separate method vs. parameterized existing method) is resolved below in the architecture review.

## Complexity Audit

### Routine
- The `_buildDrivePrefix` function already resolves the team roster, API port, and operational rules. The batch path needs the same resolution with different instruction text.
- The gate at line 6394 is a single condition — changing it to also fire for batch mode is a small edit.
- `batchOptions` is function-scoped (declared at the top of `generateUnifiedPrompt`, before the if/else chain), so it is in scope at line 6394. The gate fix references it correctly.

### Complex / Risky
- The existing `_buildDrivePrefix` is feature-file-centric: it includes instructions like "Read the feature file's Team Dispatch Instructions section" and "All subtasks are part of a single delivery unit." These are wrong for a batch of loose plans. A batch-specific variant is needed.
- The batch lead must open individual plan files (the feature path forbids this). The drive prefix must be adapted: replace feature-file references with "Read each plan file below" and replace the "single delivery unit" clause with "the plans are independent."
- The `batchOptions.batchMode` flag already exists and is set to `true` for the batch path. The drive prefix variant can branch on this flag.
- The `_buildFeatureDirectivePrefix` also handles `goal` and `ultracode` prefixes — those are orthogonal and should still fire only for real features.
- Roster/port resolution logic (~15 lines) is duplicated between `_buildDrivePrefix` and the proposed `_buildBatchDrivePrefix`. Extract a shared helper to avoid a maintenance trap.

## Edge-Case & Dependency Audit

- **No team roster resolves:** `_buildDrivePrefix` returns `null` when no team group is found. The batch path already gates on `isCodingTeamHead` (line 6352), so a team roster should always resolve. If it does not (race condition, team disbanded mid-dispatch), the gate falls through to `return built` — the lead gets a batch prompt with no dispatch means. This is acceptable: the team-head gate is the safety net, and a null roster after passing the gate is an edge case that should not crash. No static fallback text is needed — the prompt without a prefix is still functional, just suboptimal. The lead can read `.switchboard/api-server-port.txt` and resolve the team from the team wiring config manually.
- **API port file missing:** `_buildDrivePrefix` reads `.switchboard/api-server-port.txt` with a fallback string (`'read .switchboard/api-server-port.txt'`). This is fine for the batch path too — the shared helper handles it.
- **ptySendPrompt recipe:** The recipe tells the lead how to dispatch to seats. It's the same for feature and batch (the seats don't change). Can be shared.
- **Per-subtask completion POST:** The completion POST endpoint is the same regardless of feature vs. batch. Can be shared.
- **`goal` / `ultracode` prefixes:** These are board-level toggles that prepend slash commands. They should NOT fire for a batch of loose plans (they're feature-specific). The gate must distinguish "real feature" from "batch with featureMode=true."
- **`orderedPlans` vs full set:** At the gate, `orderedPlans` has been reassigned from `partition.loosePlans` to `sent` (the capped subset from `selectTeamBatchPlans`). The batch prefix receives the capped plans. This is correct: the completion POST references per-subtask planIds from the sent set, not the full column. The roster lines do not depend on the plans at all (workspace-scoped).

## Dependencies

None — this is the foundational fix. Other subtasks in the feature (npx divergence, missing tests) depend on this gate fix being in place.

## Adversarial Synthesis

Key risks: (1) roster/port code duplication between `_buildDrivePrefix` and `_buildBatchDrivePrefix` creates a maintenance trap — mitigate by extracting a shared `_resolveRosterAndPort` helper. (2) The null-roster case after the team-head gate falls through to no prefix — acceptable since the gate is the safety net, but must be documented. (3) A unit test of `_buildBatchDrivePrefix` alone does not verify the gate fix — a full-path test through `generateUnifiedPrompt` is required.

## Proposed Changes

### 1. Extract shared roster/port resolution (src/services/KanbanProvider.ts)

Extract the roster resolution, port file read, and roster line formatting from `_buildDrivePrefix` into a shared helper:

```typescript
private async _resolveRosterAndPort(workspaceRoot: string): Promise<{
    rosterLines: string[];
    portLine: string;
    portResolved: boolean;
} | null> {
    const roster = await this._resolveTeamRosterForPrompt(workspaceRoot);
    if (!roster || roster.length === 0) return null;

    let portLine = 'read .switchboard/api-server-port.txt';
    try {
        const portFilePath = path.join(workspaceRoot, '.switchboard', 'api-server-port.txt');
        if (fs.existsSync(portFilePath)) {
            const portRaw = fs.readFileSync(portFilePath, 'utf8').trim();
            if (portRaw && /^\d+$/.test(portRaw)) {
                portLine = `Port is ${portRaw}. BASE="http://127.0.0.1:${portRaw}"`;
            }
        }
    } catch { /* best-effort */ }

    const rosterLines = roster.map(m => {
        const roleLabel = m.role ? ` (${m.role})` : '';
        const statusLabel = m.active ? 'active' : 'exited';
        return `- ${m.name}${roleLabel} — ${statusLabel}`;
    });

    return { rosterLines, portLine, portResolved: portLine.startsWith('Port is ') };
}
```

Refactor `_buildDrivePrefix` to call this helper, preserving its existing behavior exactly.

### 2. Add `_buildBatchDrivePrefix` (src/services/KanbanProvider.ts)

Create a batch-specific drive prefix that calls the shared helper but replaces feature-file-centric instructions with batch-appropriate ones:

```typescript
private async _buildBatchDrivePrefix(workspaceRoot: string, plans: BatchPromptPlan[]): Promise<string | null> {
    const resolved = await this._resolveRosterAndPort(workspaceRoot);
    if (!resolved) return null;
    const { rosterLines, portLine, portResolved } = resolved;

    const closeOutTarget = portResolved
        ? 'against $BASE'
        : 'against the port in .switchboard/api-server-port.txt';
    const skipPortDirective = portResolved
        ? ' Do NOT read .switchboard/api-server-port.txt (the port is above).'
        : '';

    const block = [
        `You are driving a batch of loose plans through your team seats. Everything you need is below — the port, your team roster, and the plan list are all in this prompt.${skipPortDirective} Do NOT check your own terminal name — you dispatch TO named seats (see YOUR TEAM below), and standing orders handle callbacks.`,
        '',
        'YOUR TEAM:',
        ...rosterLines,
        '',
        `API: ${portLine}`,
        'Standing orders: callback contract is installed on all workers — they report to you on completion. Do not re-register.',
        '',
        'STAGING (one call per plan):',
        'curl -s -X POST "$BASE/terminals/verb/ptySendPrompt" -H "Content-Type: application/json" --max-time 30 \\',
        '  -d \'{"name":"<seat>","data":"Implement the plan at <path>. This plan only.","clearBeforePrompt":false,"dispatch":{"planId":"<id>","role":"coder"}}\'',
        '',
        'REVIEW: On callback, review git diff — not the coder\'s self-report. Coder self-report does not clear context; resend fixes to the same terminal (context preserved). Escalate after two failures on the same plan: intern → coder → lead.',
        '',
        `CLOSE OUT EVERY PLAN — ALWAYS, no judgement call. When you are finished with a plan, commit, then POST /kanban/task/complete with {"from":"<your terminal name>","planId":"<that plan's planId>","workspaceRoot":"<your cwd>"} ${closeOutTarget}. Post per plan, with that plan's planId. Nothing downstream happens until you post: the coder is not cleared and you cannot be handed the next plan.`,
        '',
        'BATCH RULES:',
        '- The plans in this batch are independent and possibly unrelated.',
        '- Read each individual plan file for requirements, seat assignments, and scope constraints.',
        '- Sequence plans that collide; dispatch non-colliding plans in parallel.',
        '- One plan per terminal at a time. Use a second terminal for concurrency.',
        '- Do NOT rewrite or edit plan files. The plan is the source of truth for the coder that receives it.',
        '- Do NOT query kanban.db directly. Use the API for anything else.',
        '- Do NOT verify work before dispatching. The kanban column is the system\'s record, not a coder\'s claim.',
        '- Never issue a git verb (commit, push, branch, merge) to a team seat. The head commits the team\'s work; coders never commit.',
        '- You are unattended when no human is demonstrably reading. When you cannot tell, assume unattended.',
        '- Unattended: never convert uncertainty into a stop. Record a question report and continue in the same turn.',
        '- clearBeforePrompt stays false on every dispatch — the host overrides it to true automatically when the plan changes.',
    ];

    return block.join('\n');
}
```

Key differences from `_buildDrivePrefix`:
- Opener says "a batch of loose plans" not "this feature."
- No FEATURE FILE line — the lead reads individual plan files instead.
- "BATCH RULES" replaces "RULES" — includes "plans are independent" and "Read each individual plan file."
- Removes "Do NOT open individual subtask plans" (the batch lead MUST open them).
- Removes "single delivery unit" clause.
- Completion POST says "per plan" not "per subtask."

### 3. Fix the gate at line 6394 (src/services/KanbanProvider.ts:6394–6400)

Change the condition to also fire for batch-to-team-head, and route to the batch variant:

```typescript
const isRealFeature = plans.some(p => p.isFeature);
const isBatchTeamHead = batchOptions.batchMode === true && !isRealFeature;

if (isRealFeature && ['lead', 'coder', 'intern'].includes(role)) {
    const prefix = await this._buildFeatureDirectivePrefix(workspaceRoot, await resolveDrive(), plans);
    if (prefix) {
        return `${prefix}${built}`;
    }
} else if (isBatchTeamHead && role === 'lead') {
    const batchPrefix = await this._buildBatchDrivePrefix(workspaceRoot, orderedPlans);
    if (batchPrefix) {
        return `${batchPrefix}\n\n${built}`;
    }
}
return built;
```

`batchOptions` is function-scoped (declared at the top of `generateUnifiedPrompt`), so it is in scope at line 6394. `orderedPlans` is the capped subset (reassigned from `partition.loosePlans` to `sent` at line 6359) — this is correct because the completion POST references planIds from the sent set.

## Verification Plan

### Automated Tests

1. **Unit test:** Build a batch prompt for 5 loose plans with a team-headed lead — assert the prompt contains the YOUR TEAM roster, the API port, the ptySendPrompt recipe, and the per-plan completion POST.
2. **Unit test:** Build a batch prompt for 5 loose plans with a non-team lead — assert NO drive prefix is prepended (the gate must not fire).
3. **Unit test:** Build a real feature dispatch — assert the feature-file-centric drive prefix is used (not the batch variant).
4. **Unit test:** Build a batch prompt with no team roster resolvable — assert no crash and no prefix (graceful fallthrough to `return built`).
5. **Unit test:** Assert the batch drive prefix does NOT contain "single delivery unit" or "Read the feature file's Team Dispatch Instructions section."
6. **Unit test:** Assert the batch drive prefix DOES contain "Read each individual plan file" or equivalent.
7. **Full-path test:** Call `generateUnifiedPrompt('lead', loosePlans, workspaceRoot, { isTeamHead: true })` — assert the returned prompt starts with the batch drive prefix (roster, port, dispatch recipe), not just the batch prompt body. This verifies the gate fix, not just the builder method.

### Goal Invariants

- **Positive:** `generateUnifiedPrompt` with `role='lead'`, `batchMode=true`, and a team-headed lead returns a string containing `YOUR TEAM:` and `API:` and `ptySendPrompt` and `/kanban/task/complete`.
- **Negative:** `generateUnifiedPrompt` with `role='lead'`, `batchMode=true`, and a team-headed lead does NOT return a string containing `FEATURE FILE:` or `single delivery unit` or `Team Dispatch Instructions`.
- **Negative:** `generateUnifiedPrompt` with `role='coder'` and `batchMode=true` does NOT prepend a batch drive prefix (the gate is `role === 'lead'` only).
- **Positive:** `_resolveRosterAndPort` returns identical `rosterLines` and `portLine` values to the original inline code in `_buildDrivePrefix` (refactor does not change behavior).

## Implementation Summary

Extracted shared helper `_resolveRosterAndPort` to consolidate team roster resolution, API port file reading, and roster line formatting across drive prefixes. Added `_buildBatchDrivePrefix` to generate a batch-specific drive prefix that instructs team leads to read individual plan files and dispatch per-plan without feature file constraints. Updated the directive gate in `generateUnifiedPrompt` so that batch dispatches to team head leads (`batchMode === true && !isRealFeature && role === 'lead'`) prepend `_buildBatchDrivePrefix`. Added automated contract tests in `batch-move-team-prompt-contract.test.js` validating the batch drive prefix, roster lines, staging recipe, negative assertions, and gate routing.
