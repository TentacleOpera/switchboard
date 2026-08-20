# Make the Feature File the Lead's Single Source of Truth and Retire the Dispatch Skill

## Goal

The lead coder in a drive-mode team reads all 9 subtask plan files on its first turn because the feature file doesn't contain what it needs to dispatch and review. It also reads a 689-line skill file (`terminal-coder-dispatch/SKILL.md`) because the enriched drive prefix points to it. Both reads are waste: the feature file should carry the dispatch and review metadata, and the skill's load-bearing rules (7 of them) should be inlined into the prefix where the lead already reads them.

This plan does three things:
1. Enriches the feature file with a `## Team Dispatch Instructions` section (planner-authored) and plan IDs in the auto-generated Subtasks section.
2. Simplifies the enriched drive prefix: points the lead at the feature file, inlines the 7 behavioral rules from the skill, drops the SUBTASKS list, and removes the skill pointer + port file reference.
3. Deletes the skill file entirely and retargets its contract tests to the enriched prefix.

### Root Cause Analysis

The lead's multi-file read is not waste — it's the only way to get information the feature file and prefix don't carry. The waste is that they don't carry it. Three things are missing from the feature file:

1. **Plan IDs** — needed for the `dispatch` field in the `ptySendPrompt` curl call. Currently only in the enriched drive prefix's SUBTASKS section, not in the feature file.
2. **Seat / recommended role** — which terminal to dispatch each subtask to. Currently in the kanban DB's plan record (`recommendedRole`), not in the feature file.
3. **Acceptance criteria and scope constraints** — what to check when reviewing a coder's diff, and what the coder must not touch. Currently in each plan file's Verification Plan and scope sections, not in the feature file.

And two things are missing from the prefix (currently only in the skill file):

4. **Review conduct rules** — cite plan clauses, name the defect not the mechanism, never issue git verbs to team seats.
5. **Unattended driving rules** — when you can't tell if a human is watching, assume unattended; record questions and continue; block only on irreversible actions.

The planner already reads every subtask plan during improve-feature (Step 2: improve every subtask, Step 3: cross-subtask reconciliation). By the time it backfills the feature file's description sections (Step 5), it has all the information needed to write dispatch instructions — it just isn't asked to. The 7 behavioral rules are already written and verified accurate against the current code; they just live in a 689-line file the lead has to read instead of in the prefix where they'd be immediately available.

### Background

The feature file currently has planner-authored sections (Goal, How the Subtasks Achieve This, Dependencies & sequencing) and auto-generated blocks (Subtasks, Worktrees). The planner writes the authored sections via `WRITE_FEATURE_DESCRIPTION_IF_EMPTY_DIRECTIVE` and the improve-feature skill's Step 5. The auto-generated blocks are maintained by `_regenerateFeatureFile` in KanbanProvider.ts, which reads subtask records from the DB and replaces the marked sections while preserving everything outside them.

The enriched drive prefix (`_buildDrivePrefix` in KanbanProvider.ts, lines ~5607-5642) currently inlines the team roster, port, curl template, a SUBTASKS section listing all plan IDs + paths, rules, and a skill file pointer. The rules section already covers: don't rewrite plan files, don't query kanban.db, clear at rest, one subtask per terminal. It does NOT cover: review conduct (cite plan clauses, name defect not mechanism, no git verbs to seats) or unattended driving (assume unattended, record and continue, block on irreversible only). Those 7 rules live in the skill file's §5.5 and §5.6.

The skill file is 689 lines. An audit of every section against the current code found that ~520 lines are redundant (already in the prefix, already enforced by the system's delivery layer, standing orders, seat directive blocks, or feature watch), ~100 lines are edge-case diagnostics derivable from the system's own responses (feature watch covers dead terminals, `directivesAttached` covers registration failure, roster is in the prefix), and ~70 lines are the 7 genuinely needed behavioral rules. The skill's §5.5 and §5.6 rules were verified accurate against the current code: the "team commits once" rule is enforced by `resolveTeamStanding` → `buildSeatDirectiveBlock` (head gets `whenDone`, members get `dontCommit`); the two dispatch mechanisms (`ptySendPrompt` with `dispatch` field for subtasks, `POST /kanban/dispatch` with `targetColumn` for handing to review) are sequential workflow stages, not contradictions; `queue/next` is for pulling the next feature after review, not for subtask dispatch.

## Metadata

> **Superseded:** Complexity: 6
> **Reason:** The improve pass uncovered that the test retargeting (change #7) is a contract rewrite of 40+ assertions across 4 test files, not a mechanical redirect, and that the skill deletion cascades into a DRIVE_FEATURE_PREFIX fix (change #8) and a module-level readFileSync crash in seat-safeguards-fleet-prompt-path.test.js. These push the plan past "majority routine with one or two moderate risks" into "multi-file coordination with data-consistency risks."
> **Replaced with:** Complexity: 7

**Complexity:** 7
**Tags:** backend, refactor, feature
**Project:** Browser Switchboard

## User Review Required

- **Test retargeting strategy:** The plan deletes `terminal-coder-dispatch/SKILL.md` and retargets 4 test files. The `terminal-coder-dispatch-contract.test.js` file has 40+ assertions pinning exact wording from §5.5, §5.6, §6, and §7 — observed-failure anecdotes, all 10 default-action table rows, and regression rules. The inlined 7 rules are condensations that don't contain this wording. The user should review the per-assertion decision (retarget by rewriting to match condensed wording, drop with rationale, or expand the inlined rules) before implementation, because dropping assertions loses the regression guard the test was built to provide. Proceeding on the assumption that the coder will rewrite each assertion to match the prefix's condensed wording where possible and drop only the observed-failure anecdote assertions (which were illustrative, not operational).

- **Review fidelity dependency:** The Team Dispatch Instructions carry *distilled* acceptance criteria (2-5 bullets per subtask). The lead reviews against this distillation, not the full plan's Verification Plan. Proceeding on the assumption that the distillation is sufficient for review and that coders reading the full plan files compensates for any fidelity loss.

## Complexity Audit

### Routine
- Adding plan ID to the Subtasks section line in `_regenerateFeatureFile` — one template literal change, same data class as existing path/column metadata.
- Extending `WRITE_FEATURE_DESCRIPTION_IF_EMPTY_DIRECTIVE` with a 4th section instruction — appending text to an existing string constant.
- Updating `improve-feature/SKILL.md` Step 5 to list `## Team Dispatch Instructions` — one line edit in two mirror files.
- Adding a line to the drive-mode branch of `resolveFeatureOrchestrationDirective` — one string concatenation in an existing `if (driveMode)` block.
- Removing the SUBTASKS section, skill pointer, and port file reference from `_buildDrivePrefix` — deleting lines from an array literal.
- Inlining 7 rules into the prefix RULES section — adding 7 string lines to an array literal.
- Deleting 2 skill files (`terminal-coder-dispatch/SKILL.md` in `.agents/` and `.claude/`).
- Updating a comment in `standing-orders-marker-contract.test.js`.

### Complex / Risky
- **Test retargeting (change #7):** `terminal-coder-dispatch-contract.test.js` has 40+ assertions pinning exact wording from the skill file's §5.5, §5.6, §6, §7 — including observed-failure anecdotes, all 10 default-action table rows, and regression rules ("Never clear yourself," "ptyClearAllTerminals," "Standing orders survive a clear"). The inlined 7 rules are condensations that don't contain this wording. Retargeting requires per-assertion decisions: rewrite to match condensed wording, drop with rationale, or expand the inlined rules. This is a contract rewrite, not a mechanical redirect.
- **Module-level file read crash:** `seat-safeguards-fleet-prompt-path.test.js` reads the skill file at module level (lines 64-68, `fs.readFileSync`). Deleting the skill file crashes the entire test file at import time — all 30+ tests, not just the 2 that assert on skill content. The module-level reads must be removed, not just the assertions.
- **DRIVE_FEATURE_PREFIX dangling reference:** The fallback prefix at `KanbanProvider.ts:77` tells the agent to read the skill file. Deleting the skill file without updating this string sends every non-team drive-mode dispatch to a phantom file. See change #8.
- **Review fidelity:** The lead reviews against distilled acceptance criteria, not the full Verification Plan. If the planner's distillation is lossy, review quality degrades silently while the "lead reads one file" metric stays green.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `_regenerateFeatureFile` is called from many sites (column moves, feature assignment, completion). Adding plan IDs to the Subtasks section is auto-generated and replaces the marked block — no race with planner-authored content (the Team Dispatch Instructions section is outside the BEGIN/END markers and preserved).
- The Team Dispatch Instructions section is planner-authored and lives between Dependencies & sequencing and the BEGIN SUBTASKS marker. If the planner writes it before the subtask set is final (e.g. during improve-feature Step 2 before Step 4 restructuring), a later merge/split/delete could leave stale dispatch instructions referencing a deleted subtask. The improve-feature skill's Step 5 runs after Step 4 restructuring, so this is sequenced correctly — but a manual feature file edit could desynchronize.

**Security:**
- No new attack surface. The plan IDs added to the Subtasks section are already in the kanban DB and the enriched prefix — no new data exposure.

**Side Effects:**
- Deleting the skill file removes the `terminal-coder-dispatch` skill from the skill registry. The available-skills list in the system prompt and the `.agents/.switchboard-bundled.json` manifest will auto-regenerate on next extension startup (both are generated by `SwitchboardControlPlane` and `ClaudeCodeMirrorService` respectively). No manual manifest update needed, but the skill will disappear from the skill list until regeneration runs.
- The `DRIVE_FEATURE_PREFIX` fallback is used when no team roster resolves (no lead-headed team group with a live head). Updating it (change #8) changes the prompt for all non-team drive-mode dispatches — a behavioral change for a currently-working path.

**Dependencies & Conflicts:**
- Change #5d (FEATURE FILE line in prefix) depends on changes #1 and #2 (feature file has plan IDs and Team Dispatch Instructions). If the feature file doesn't have the Team Dispatch Instructions section yet (planner hasn't run improve-feature), the prefix points the lead at a section that doesn't exist. The lead would fall back to reading plan files — the exact waste this plan eliminates. This is acceptable: the prefix says "Read it — its Team Dispatch Instructions section has..." which is aspirational until the planner fills it in, and the lead can still dispatch from the Subtasks section (which has plan IDs after change #1).
- Change #7 (delete skill) depends on change #5 (inline rules) — the 7 rules must be in the prefix before the skill file is removed.
- The `.claude/skills/improve-feature/SKILL.md` mirror must be updated alongside `.agents/skills/improve-feature/SKILL.md` (change #4). `ClaudeCodeMirrorService` generates the `.claude/` mirror from `.agents/`, so updating `.agents/` is sufficient for auto-regeneration, but the plan correctly updates both manually for immediate effect.

## Dependencies

- None — this plan is self-contained. All referenced code and skill files are in the current codebase.

## Adversarial Synthesis

Key risks: (1) `DRIVE_FEATURE_PREFIX` fallback points to the deleted skill file — must be updated (change #8); (2) test retargeting is a 40+ assertion contract rewrite, not a mechanical redirect — the plan's original description covers ~10 assertions; (3) `seat-safeguards-fleet-prompt-path.test.js` crashes at import time (module-level `readFileSync` of the deleted file) — must remove the reads, not just the assertions; (4) the function named `buildFeatureDirectiveBlock` in change #6 doesn't exist — the actual function is `resolveFeatureOrchestrationDirective`. Mitigations: add change #8 for the fallback prefix; expand change #7a with the full assertion inventory and per-assertion retarget/drop decision; fix the function name; note that skill manifests auto-regenerate.

## Proposed Changes

### 1. Add plan IDs to the auto-generated Subtasks section

**File:** `src/services/KanbanProvider.ts`, `_regenerateFeatureFile` method, line ~14189-14194

**Current:**
```typescript
const subtaskLines = subtasks.map(st => {
    const basename = path.basename(st.planFile);
    const topic = st.topic || basename;
    const column = this._normalizeLegacyKanbanColumn(st.kanbanColumn) || 'CREATED';
    return `- [ ] [${topic}](../plans/${basename}) — **${column}**`;
});
```

**Change:**
```typescript
const subtaskLines = subtasks.map(st => {
    const basename = path.basename(st.planFile);
    const topic = st.topic || basename;
    const column = this._normalizeLegacyKanbanColumn(st.kanbanColumn) || 'CREATED';
    const planId = st.planId ? ` — ID: ${st.planId}` : '';
    return `- [ ] [${topic}](../plans/${basename}) — **${column}**${planId}`;
});
```

The plan ID is the same class of metadata as the path and column already in the line — it's auto-generated from the DB record. This gives the lead the plan ID it needs for the `dispatch` field in the curl call, without reading the individual plan file or the prefix's SUBTASKS list.

### 2. New `## Team Dispatch Instructions` section in the feature file

**What it contains:** Per subtask, the dispatch and review details the lead needs:

```markdown
## Team Dispatch Instructions

### <subtask title>
- **Seat:** coder
- **Acceptance:** <compact criteria distilled from the plan's Verification Plan — what to check in the diff>
- **Must not touch:** <scope constraints from the plan — files, modules, or surfaces the coder must not modify>

### <subtask title>
- **Seat:** intern
- **Acceptance:** ...
- **Must not touch:** ...
```

**Who writes it:** The planner, during improve-feature. The planner already reads every subtask plan in Step 2 and does the reconciliation audit in Step 3. By Step 5 (backfill feature description), it has everything it needs.

**Where it lives:** Between the Dependencies & sequencing section and the auto-generated Subtasks block. It is planner-authored — the regeneration preserves it (it's outside the BEGIN/END markers).

**What it does NOT contain:** Plan IDs (the planner can't know them — they're assigned by the importer on file creation) or plan file paths (already in the Subtasks section's links). It references subtasks by title, matching the titles in the Subtasks section.

### 3. Planner directive: instruct the planner to write Team Dispatch Instructions

**File:** `src/services/agentPromptBuilder.ts`

Extend the `WRITE_FEATURE_DESCRIPTION_IF_EMPTY_DIRECTIVE` (line ~976) to include the Team Dispatch Instructions section. The directive tells the planner:

- After improving all subtasks and doing the reconciliation audit, write a `## Team Dispatch Instructions` section in the feature file.
- For each subtask, distill from the plan file: the recommended seat (from the complexity routing it just assigned), the acceptance criteria (from the plan's Verification Plan — compact, not the full test methodology), and scope constraints (what the plan says not to touch).
- Reference each subtask by its title (matching the Subtasks section).
- Place the section between Dependencies & sequencing and the BEGIN SUBTASKS marker.
- Do not duplicate plan IDs or file paths — those are in the Subtasks section.
- If the section already exists with substantive content, leave it untouched (same backfill semantics as Goal/How/Dependencies).

**Format:**
```
TEAM DISPATCH INSTRUCTIONS: In addition to the Goal, How, and Dependencies sections above, write a ## Team Dispatch Instructions section in the feature file. For each subtask, write a ### <subtask title> subsection with:
- **Seat:** the recommended role (intern, coder, or lead) from the complexity routing you assigned in Step 2.
- **Acceptance:** 2-5 bullet points distilled from the plan's Verification Plan — the concrete checks a reviewer performs against the diff (e.g. "compiles", "endpoint X returns Y", "test Z passes"). Not the full test methodology — just what a reviewer checks.
- **Must not touch:** files, modules, or surfaces the plan says the coder must not modify. If the plan has no scope constraints, write "None specified."
Reference each subtask by its title, matching the Subtasks section. Do not include plan IDs or file paths — those are in the Subtasks section. Place this section between Dependencies & sequencing and the BEGIN SUBTASKS marker. If a ## Team Dispatch Instructions section already exists with substantive content, leave it untouched.
```

### 4. Update improve-feature SKILL.md Step 5

**File:** `.agents/skills/improve-feature/SKILL.md`, Step 5 (line ~53)

**Current:**
```
5. **Backfill the feature file's own description.** Ensure the feature has `## Goal`, `## How the Subtasks Achieve This`, and `## Dependencies & sequencing` (backfill from the subtasks if missing; don't overwrite existing content; never touch the auto-block). Optionally record the reconciled merge map / end-state here so a coder implements to one design.
```

**Change:** Add `## Team Dispatch Instructions` to the list of sections to backfill:
```
5. **Backfill the feature file's own description.** Ensure the feature has `## Goal`, `## How the Subtasks Achieve This`, `## Dependencies & sequencing`, and `## Team Dispatch Instructions` (backfill from the subtasks if missing; don't overwrite existing content; never touch the auto-block). The Team Dispatch Instructions section contains per-subtask dispatch and review details (seat, acceptance criteria, scope constraints) so a drive-mode team lead can dispatch and review from the feature file alone without reading each plan file. Optionally record the reconciled merge map / end-state here so a coder implements to one design.
```

Also update the `.claude/skills/improve-feature/SKILL.md` mirror to match.

### 5. Inline the 7 behavioral rules into the enriched drive prefix and simplify the prefix

**File:** `src/services/KanbanProvider.ts`, `_buildDrivePrefix` method, lines ~5607-5642

**Current prefix structure:**
```
You are driving this feature through your team seats. Everything you need is below — do not look anything up.

YOUR TEAM: <roster>

API: <port>
Your terminal name is in $SWITCHBOARD_TERMINAL.
Standing orders: callback contract is installed on all workers — they report to you on completion. Do not re-register.

DISPATCH (one call per subtask): <curl template>

REVIEW: On callback, review git diff — not the coder's self-report. Resend fixes to the same terminal (context preserved). Escalate after two failures on the same subtask: intern → coder → lead.

FEATURE WATCH: Armed by the system (stopColumns: CODE REVIEWED). You will be nudged if you go idle with un-accepted subtasks. No action needed.

RULES:
- Do NOT rewrite or edit plan files. The plan is the source of truth — read it, dispatch based on it, review against it, never modify its content.
- Do NOT query kanban.db directly. The plan IDs are in your prompt; use the API for anything else.
- Do NOT verify work before dispatching. The kanban column is the system's record, not a coder's claim.
- Clear a terminal only when at rest (completion received AND next work goes elsewhere).
- One subtask per terminal at a time. Use a second terminal for concurrency.
- Full protocol (escalation ladder, unattended mode, resting terminals, failure modes): .agents/skills/terminal-coder-dispatch/SKILL.md

SUBTASKS: <plan IDs + paths>
```

**Changes:**

a) **Remove the SUBTASKS section** (lines ~5634-5640) that lists all plan IDs and paths. The feature file's Subtasks section (now with plan IDs) and Team Dispatch Instructions section have this.

b) **Remove the skill file pointer** (line ~5631): `"Full protocol ... .agents/skills/terminal-coder-dispatch/SKILL.md"`. The 7 rules are being inlined (see item f below).

c) **Drop the port file reference** in the API line: change `"Port is ${portRaw}. BASE=... (also in .switchboard/api-server-port.txt)"` to `"Port is ${portRaw}. BASE=..."`.

d) **Add a FEATURE FILE line** after the REVIEW line: extract the feature plan's path from the `plans` array (the entry with `isFeature: true`) and add:
```
FEATURE FILE: <path>. Read it — its Subtasks section has plan IDs and file paths; its Team Dispatch Instructions section has seat assignments, acceptance criteria, and scope constraints for each subtask. This is your single source of truth for dispatch and review.
```

e) **Keep unchanged:** roster, port, curl template, standing orders note, review/escalation summary, feature watch note, the first 5 rules (don't rewrite plans, don't query kanban.db, don't verify before dispatching, clear at rest, one subtask per terminal).

f) **Add 7 inlined rules** to the RULES section, replacing the skill pointer line:

Review conduct (from skill §5.5):
```
- Every finding cites a plan clause. Quote the section or line the diff violates. A defect you cannot cite is a question report, not a dispatch.
- Name the defect, never the mechanism. State what is wrong and which plan clause it breaks; do not tell the coder how to fix it. Where the plan itself names a mechanism, quote the plan verbatim.
- Never issue a git verb (commit, push, branch, merge) to a team seat. The head commits the team's work; coders never commit.
```

Unattended driving (from skill §5.6):
```
- You are unattended when no human is demonstrably reading. When you cannot tell, assume unattended.
- Unattended: never convert uncertainty into a stop. Record a question report to .switchboard/orchestrator/reports/ and continue in the same turn — recording is not asking, and does not end your turn.
- Subtask blocked after escalation: record blocked, leave the card, move to the next subtask.
- Anything irreversible (destructive git, pushing, deleting data or cards): stop and record. The only unattended action that blocks.
```

**Resulting prefix structure:**
```
You are driving this feature through your team seats. Everything you need is below — do not look anything up.

YOUR TEAM: <roster>

API: <port>
Your terminal name is in $SWITCHBOARD_TERMINAL.
Standing orders: callback contract is installed on all workers — they report to you on completion. Do not re-register.

DISPATCH (one call per subtask): <curl template>

REVIEW: On callback, review git diff — not the coder's self-report. Resend fixes to the same terminal (context preserved). Escalate after two failures on the same subtask: intern → coder → lead.

FEATURE WATCH: Armed by the system (stopColumns: CODE REVIEWED). You will be nudged if you go idle with un-accepted subtasks. No action needed.

FEATURE FILE: <path>. Read it — its Subtasks section has plan IDs and file paths; its Team Dispatch Instructions section has seat assignments, acceptance criteria, and scope constraints for each subtask. This is your single source of truth for dispatch and review.

RULES:
- Do NOT rewrite or edit plan files. The plan is the source of truth — read it, dispatch based on it, review against it, never modify its content.
- Do NOT query kanban.db directly. The plan IDs are in your prompt; use the API for anything else.
- Do NOT verify work before dispatching. The kanban column is the system's record, not a coder's claim.
- Clear a terminal only when at rest (completion received AND next work goes elsewhere).
- One subtask per terminal at a time. Use a second terminal for concurrency.
- Every finding cites a plan clause. Quote the section or line the diff violates. A defect you cannot cite is a question report, not a dispatch.
- Name the defect, never the mechanism. State what is wrong and which plan clause it breaks; do not tell the coder how to fix it. Where the plan itself names a mechanism, quote the plan verbatim.
- Never issue a git verb (commit, push, branch, merge) to a team seat. The head commits the team's work; coders never commit.
- You are unattended when no human is demonstrably reading. When you cannot tell, assume unattended.
- Unattended: never convert uncertainty into a stop. Record a question report to .switchboard/orchestrator/reports/ and continue in the same turn — recording is not asking, and does not end your turn.
- Subtask blocked after escalation: record blocked, leave the card, move to the next subtask.
- Anything irreversible (destructive git, pushing, deleting data or cards): stop and record. The only unattended action that blocks.
```

### 6. Update the lead's feature directive for drive mode

**File:** `src/services/agentPromptBuilder.ts`, `resolveFeatureOrchestrationDirective` function, drive-mode branch, line ~1344-1349

**Current:**
```typescript
if (driveMode) {
    return `${opener('driving')}\n` +
        `Dispatch each subtask to a seat on your team — do not implement subtasks yourself. ` +
        `Review each coder's diff before accepting its work; resend a fix prompt to the same seat if it falls short. ` +
        `${unitClause}\n` +
        `Before starting, briefly tell the user how you plan to dispatch the subtasks across your seats.`;
}
```

**Change:** Add a line pointing the lead at the feature file's Team Dispatch Instructions section:
```typescript
if (driveMode) {
    return `${opener('driving')}\n` +
        `Dispatch each subtask to a seat on your team — do not implement subtasks yourself. ` +
        `Review each coder's diff before accepting its work; resend a fix prompt to the same seat if it falls short. ` +
        `Read the feature file's Team Dispatch Instructions section for seat assignments, acceptance criteria, and scope constraints per subtask — do not read individual plan files. ` +
        `${unitClause}\n` +
        `Before starting, briefly tell the user how you plan to dispatch the subtasks across your seats.`;
}
```

The "briefly tell the user" line stays — the lead reads the feature file, forms its dispatch plan, tells the user, then dispatches.

### 7. Delete the skill file and retarget contract tests

**Delete:**
- `.agents/skills/terminal-coder-dispatch/SKILL.md`
- `.claude/skills/terminal-coder-dispatch/SKILL.md`

**Retarget 4 test files:**

a) **`src/test/terminal-coder-dispatch-contract.test.js`** — currently reads the skill file and asserts on 10 categories of content. Retarget every assertion to the enriched prefix source in `KanbanProvider.ts` (the `_buildDrivePrefix` method). The assertions pin the same load-bearing rules — they just read them from the prefix source text instead of the skill file. Specific retargeting:
   - Authority order → the prefix's plan-immutability rule + the authority order implicit in "the plan is the source of truth"
   - Finding-cites-plan-clause → assert the prefix contains "Every finding cites a plan clause"
   - Name-defect-not-mechanism → assert the prefix contains "Name the defect, never the mechanism"
   - Git-verb prohibition → assert the prefix contains "Never issue a git verb" and "coders never commit"
   - Review conformance (§5 mechanism check) → assert the prefix contains "Where the plan itself names a mechanism, quote the plan verbatim"
   - Never-message-a-working-seat → already covered by "Clear a terminal only when at rest" + "One subtask per terminal"
   - Clear-at-rest → already in the prefix, unchanged
   - §5.6 unattended table → assert the prefix contains the 4 unattended rules (assume unattended, record and continue, blocked→next, irreversible→stop)
   - §6 escalation → already in the prefix's REVIEW line
   - §7 regression rules (never clear yourself, ptyClearAllTerminals, standing orders survive clear) → these are operational details already enforced by the system; drop the assertions or retarget to the prefix's "Clear a terminal only when at rest" rule

   Note: the observed-failure anecdotes (war stories) in the skill are not asserted in the prefix — they were illustrative context, not operational rules. Drop those assertions.

b) **`src/test/proactive-terminal-rest-clear-contract.test.js`** — 3 tests read the skill file for ptyClearTerminal, rest preconditions, and clearBeforePrompt: false. Retarget: the "clear at rest" rule is already in the prefix. The `ptyClearTerminal` verb name and `clearBeforePrompt: false` mandate are operational details enforced by the curl template in the prefix (which already uses `"clearBeforePrompt":false`). Assert against the prefix source text.

c) **`src/test/seat-safeguards-fleet-prompt-path.test.js`** — 2 tests read the skill file for the seat-safeguards paragraph. The seat safeguards are enforced by the delivery layer (`buildSeatDirectiveBlock`), not by the skill file. Retarget: assert the seat directive block source contains the safeguards, or drop the skill-file-specific assertions since the safeguards are system-enforced and no longer documented in a skill file.

d) **`src/test/standing-orders-marker-contract.test.js`** — 1 comment references the skill file path. Update the comment; no assertion change needed.

e) **Full assertion inventory for `terminal-coder-dispatch-contract.test.js`** (added by improve pass — the original plan covered ~10 of 40+ assertions):

   The test has 10 test functions, each with multiple assertions, run against BOTH `.agents/` and `.claude/` skill mirrors. Here is the per-assertion retarget decision:

   | Test | Assertions | Retarget decision |
   |------|-----------|-------------------|
   | authority order | "authority order", "The user", "Project contracts", "plan file last" | **Drop** — the prefix's "The plan is the source of truth" rule is the operational equivalent; the full authority ladder (user > contracts > plan) is not in the prefix and adding it would expand scope. Drop with rationale. |
   | finding-cites-plan-clause | "Every finding cites a plan clause", "Quote the section or line", observed-failure anecdote | **Retarget** the first two to assert the prefix contains "Every finding cites a plan clause" and "Quote the section or line the diff violates". **Drop** the anecdote assertion. |
   | name-defect-not-mechanism | "Name the defect, never the mechanism", "The one exception...where the plan names a mechanism...quote the plan verbatim", observed-failure anecdote | **Retarget** to assert the prefix contains "Name the defect, never the mechanism" and "Where the plan itself names a mechanism, quote the plan verbatim". **Drop** the "The one exception" sub-assertion (the prefix uses different phrasing). **Drop** the anecdote. |
   | git-verb prohibition | "Never issue a git verb to a team seat", "No commit, push, branch, merge", "A team commits once / Coders never commit", observed-failure anecdote | **Retarget** to assert the prefix contains "Never issue a git verb" and "coders never commit". **Drop** the "No `commit`, `push`, `branch`, `merge`" sub-assertion (the prefix uses "(commit, push, branch, merge)" with different formatting). **Drop** the anecdote. |
   | review conformance (§5) | "Where the plan names a mechanism, verify the seat used **that** mechanism", "The function exists and has other call sites...is not conformance" | **Drop** — the prefix's "Where the plan itself names a mechanism, quote the plan verbatim" covers the quoting half; the "function exists with call sites is not conformance" warning is a review-methodology detail not in the 7 rules. Drop with rationale. |
   | never-message-a-working-seat | "Never message a seat that has not reported", "have not heard from is mid-turn", "Correcting an instruction...clear plus one authoritative dispatch", "Prefer an idle seat over a second item" | **Drop** — the plan's original rationale ("already covered by 'Clear a terminal only when at rest' + 'One subtask per terminal'") is partially correct; the specific never-message wording is not in the prefix. Drop with rationale. |
   | clear-at-rest | "mandatory for correctness", "Clear at rest, always" | **Retarget** to assert the prefix contains "Clear a terminal only when at rest". **Drop** the "mandatory for correctness" and "Clear at rest, always" sub-assertions (different phrasing in the prefix). |
   | §5.6 unattended | "## 5.6 Driving unattended" heading, "asking costs the whole night", "Which mode you are in", "When you cannot tell, you are unattended", 10 table rows, "Destructive git", "force push", "deleting user data or board cards", "A default is never an invention", "Recording is not asking", "Recording does not end your turn", "The head commits as the team's head" | **Retarget** the 4 inlined unattended rules: assert the prefix contains "You are unattended when no human is demonstrably reading", "Record a question report to .switchboard/orchestrator/reports/ and continue in the same turn", "Subtask blocked after escalation: record blocked, leave the card, move to the next subtask", "Anything irreversible (destructive git, pushing, deleting data or cards): stop and record". **Drop** all other sub-assertions (table rows, "asking costs the whole night", "A default is never an invention", "Recording is not asking", "Recording does not end your turn", "The head commits as the team's head") — these are §5.6 detail not carried in the 7 inlined rules. Drop with rationale. |
   | §6 escalation | "retires **that card**, not the session" | **Retarget** to assert the prefix's REVIEW line contains "Escalate after two failures on the same subtask: intern → coder → lead". **Drop** the "retires that card" sub-assertion. |
   | §7 regression | "Never clear yourself", "ptyClearAllTerminals", "Only clear a terminal that is genuinely at rest", "no busy check", "Standing orders survive a clear" | **Drop** — these are operational details enforced by the system, not in the 7 inlined rules. The prefix's "Clear a terminal only when at rest" covers the intent. Drop with rationale. |

   **Net effect:** ~12 assertions retargeted to prefix wording, ~30 dropped with rationale. The test shrinks from a full-skill contract to a prefix-contract. The dropped assertions lose their regression guard — this is the trade-off the User Review Required section flags. An alternative to dropping is expanding the inlined rules to include the dropped wording, but that defeats the purpose of condensing.

f) **`src/test/seat-safeguards-fleet-prompt-path.test.js` module-level reads** (added by improve pass — the original plan missed this):

   The file reads the skill file at **module level** (lines 64-68):
   ```javascript
   const SKILL_SRC = fs.readFileSync(
       path.join(__dirname, '..', '..', '.agents', 'skills', 'terminal-coder-dispatch', 'SKILL.md'), 'utf8'
   );
   const CLAUDE_SKILL_SRC = fs.readFileSync(
       path.join(__dirname, '..', '..', '.claude', 'skills', 'terminal-coder-dispatch', 'SKILL.md'), 'utf8'
   );
   ```
   Deleting the skill file crashes the **entire test file** at import time — all 30+ tests, not just the 2 that assert on skill content. The fix: remove these two `readFileSync` calls (and the `SKILL_SRC`/`CLAUDE_SKILL_SRC` constants), then remove or retarget the 2 tests at lines 791-811 that reference them. The other 28+ tests in the file don't reference the skill file and are unaffected.

### 8. Fix the DRIVE_FEATURE_PREFIX fallback (added by improve pass)

**File:** `src/services/KanbanProvider.ts`, line 77

**Current:**
```typescript
const DRIVE_FEATURE_PREFIX = 'This feature is to be driven through a coder terminal. Read and follow .agents/skills/terminal-coder-dispatch/SKILL.md.';
```

**Problem:** This fallback is used at line 5679 when `_buildDrivePrefix` returns null (no team roster resolves). It tells the agent to read the skill file that change #7 deletes. Every non-team drive-mode dispatch would point at a phantom file.

**Change:** Update the string to not reference the deleted skill file. The fallback fires when there's no team roster, so the lead has no seats to dispatch to — the prefix should say the feature is drive-mode but no team is configured, and the lead should implement directly:
```typescript
const DRIVE_FEATURE_PREFIX = 'This feature is to be driven through a coder terminal, but no team roster is configured. Implement the subtasks directly.';
```

> **Superseded:** The original plan's "What Does NOT Change" section stated "The DRIVE_FEATURE_PREFIX fallback stays."
> **Reason:** The fallback's text references the skill file being deleted. Keeping it unchanged sends the lead to a phantom file.
> **Replaced with:** Update the fallback string to not reference the deleted skill file (change #8).

### 9. Update stale comments referencing the skill file (added by improve pass)

**Files:**
- `src/services/agentPromptBuilder.ts`, line 308 — the `driveMode` field doc comment says "The DRIVE_FEATURE_PREFIX (naming terminal-coder-dispatch/SKILL.md) is prepended by KanbanProvider." Update to remove the skill file reference.
- `src/test/feature-drive-prompt-reframe-contract.test.js`, line 7 — the file header comment says "read terminal-coder-dispatch/SKILL.md". Update to reflect the new prefix-based approach.

**Note on skill manifests:** `.agents/.switchboard-bundled.json` (line 75) and `.claude/.switchboard-generated.json` (lines 42-44) both list the skill file. These are auto-generated by `SwitchboardControlPlane` and `ClaudeCodeMirrorService` respectively, and will regenerate on next extension startup. No manual update needed — but note that the skill will disappear from the available-skills list until regeneration runs.

## What Does NOT Change

- **The plan list (`PLANS TO PROCESS`) stays.** It lists all plan file paths and plan IDs. The lead can reference it, but the feature file is now the primary source. The plan list is a fallback for non-drive-mode dispatches.
- **The "briefly tell the user how you plan to dispatch" line stays.** The planning preamble is useful — the lead reads the feature file, forms a dispatch plan, tells the user, then dispatches.
- **The auto-generated Subtasks section stays.** It still lists subtask links with column status — now enriched with plan IDs. The Team Dispatch Instructions section is separate and planner-authored.
- **Non-drive-mode prompts are unchanged.** The drive prefix changes only affect drive-mode dispatches with a team roster. The feature directive change is in the `if (driveMode)` branch. The planner directive and improve-feature skill change affect all feature planning, but the Team Dispatch Instructions section is useful for any feature, not just drive-mode ones.
- **The `DRIVE_FEATURE_PREFIX` fallback stays (but its text is updated — see change #8).** When no team roster resolves, the static one-line prefix is still used. Its text no longer references the deleted skill file.
- **Plan files stay as they are.** The coders still read the full plan files for implementation detail. The lead just doesn't need to read them for dispatch and review — the feature file has that.
- **The standing order head prompt (`NEW_CODING_HEAD_PROMPT`) stays.** It teaches the non-drive-mode lead how to hand completed work to review via `POST /kanban/dispatch` and pull the next feature via `queue/next`. The enriched prefix teaches the drive-mode lead how to dispatch subtasks via `ptySendPrompt`. These are different stages of the same workflow, not contradictions.
- **The seat directive block (`buildSeatDirectiveBlock`) stays.** It enforces the "team commits once" mechanism mechanically — head gets `whenDone`, members get `dontCommit` via `resolveTeamStanding`. The inlined rule "Never issue a git verb to a team seat" is the behavioral counterpart: it prevents the head from writing "commit your work" in a dispatch prompt, which would contradict the seat directive block's `dontCommit`.

## Verification Plan

1. **Existing tests pass (after retargeting):**
   - `terminal-coder-dispatch-contract.test.js` — retargeted to assert against `_buildDrivePrefix` source text. Run: `node src/test/terminal-coder-dispatch-contract.test.js`
   - `proactive-terminal-rest-clear-contract.test.js` — retargeted to assert against prefix source. Run: `node src/test/proactive-terminal-rest-clear-contract.test.js`
   - `seat-safeguards-fleet-prompt-path.test.js` — module-level `readFileSync` calls removed (lines 64-68); 2 skill-file assertions at lines 791-811 removed or retargeted. Run: `node src/test/seat-safeguards-fleet-prompt-path.test.js`
   - `standing-orders-marker-contract.test.js` — comment update only. Run: `node src/test/standing-orders-marker-contract.test.js`
   - `drive-mode-prompt-overhaul-contract.test.js` — checks the enriched prefix contains 'YOUR TEAM:', roster entries, 'Do NOT query kanban.db directly', 'FEATURE WATCH: Armed by the system'. The plan IDs assertion needs updating (plan IDs no longer in the prefix's SUBTASKS section — they're in the feature file). New assertions: prefix does NOT contain `terminal-coder-dispatch/SKILL.md`, does NOT contain `api-server-port.txt`, DOES contain `FEATURE FILE:`, DOES contain the 7 inlined rules. Run: `node src/test/drive-mode-prompt-overhaul-contract.test.js`
   - `feature-drive-prompt-reframe-contract.test.js` — new assertion: drive-mode lead prompt contains 'Team Dispatch Instructions'. Run: `node src/test/feature-drive-prompt-reframe-contract.test.js`

2. **New test:**
   - `_regenerateFeatureFile` test: assert the Subtasks section lines include `ID: <planId>` when the subtask record has a planId.
   - `DRIVE_FEATURE_PREFIX` test: assert the fallback string does NOT contain `terminal-coder-dispatch/SKILL.md` (regression guard for change #8).

3. **Compile:** `npm run compile` — verify no TypeScript errors in changed files.

4. **Manual verification:**
   - Run improve-feature on a test feature with 2+ subtasks. Verify the feature file now has a `## Team Dispatch Instructions` section with per-subtask seat, acceptance, and scope constraints.
   - Verify the Subtasks section lines include plan IDs.
   - Dispatch a drive-mode feature with a team. Verify the lead's prompt points at the feature file, does not list all plan paths in the prefix, does not reference the skill file or port file, and contains the 7 inlined rules.
   - Verify the lead reads the feature file, tells the user its dispatch plan, and dispatches — without reading individual plan files or the skill file.
   - Verify the skill files are deleted from both `.agents/skills/` and `.claude/skills/`.
   - Verify `DRIVE_FEATURE_PREFIX` no longer references the deleted skill file (change #8).
   - Verify the `driveMode` field doc comment in `agentPromptBuilder.ts` no longer references the deleted skill file (change #9).
