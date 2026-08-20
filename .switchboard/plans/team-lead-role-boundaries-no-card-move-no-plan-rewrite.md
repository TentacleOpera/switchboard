# Team Lead Role Boundaries — No Card Moves Without a Reviewer, No Plan Rewrites

## Goal

Enforce two behavioral guardrails on the Coding team lead that are currently missing from its instructions:

1. **The lead must not advance the feature card to CODE REVIEWED unless the team has a reviewer seat.** The current `NEW_CODING_HEAD_PROMPT` unconditionally instructs the lead to call `POST /kanban/dispatch` with `targetColumn: "CODE REVIEWED"` when all subtasks are finished. This dispatches a reviewer — but if the team has no reviewer, the lead is moving a card into a column to trigger a role the team doesn't have. That is orchestrator-level board manipulation, not the lead's job. The lead should only trigger the review dispatch when its own team has a reviewer seat. When the team has no reviewer, the lead reports the feature complete and stops — it does not move the card.

2. **The lead must not rewrite plan files.** Plans are the source of truth. The lead reads them, dispatches based on them, and reviews against them. Neither the head prompt nor the drive prefix block nor the `terminal-coder-dispatch` skill explicitly prohibits rewriting plan content. The lead's only write to a plan file is the completion-report append (when it is also coding), never a rewrite of the plan's content sections.

### Problem analysis

**Issue 1 — Unconditional CODE REVIEWED advance:**

The `NEW_CODING_HEAD_PROMPT` in `src/services/teamWiring.ts` (line 382) says:

> "When every subtask of the feature is finished… make one call: POST /kanban/dispatch with {"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED","from":"{head}"} — that one call moves the card and dispatches the reviewer with the reviewer's own prompt."

This instruction is unconditional. The lead does not check whether its team has a reviewer seat before making this call. The `external-team-lead/SKILL.md` Step 4 (line 115) has the same unconditional instruction:

> "Hand whole feature to review when all subtasks pass: curl -X POST "$BASE/kanban/dispatch" … "targetColumn": "CODE REVIEWED""

The lead has access to its team roster — the drive prefix block lists "YOUR TEAM:" with each seat's role, and the head prompt itself mentions `ptyListTerminals` for membership checks. The lead *can* determine whether a reviewer seat exists; the prompt just never tells it to check.

**Issue 2 — No plan-immutability directive:**

The `terminal-coder-dispatch/SKILL.md` §5.5 has the authority order (user > project contracts > plan file) and says "The head drives, it does not design." But it never says "do not edit the plan file." The `switchboard-contracts` #3 says plan files are "write-once-at-the-end by dispatched agents" — but that's a behavior reference for *dispatched coders*, not an explicit directive to the *head*. The `CODING_COMPLETION_REPORT_DIRECTIVE` says "append a brief summary to the END" — but the lead may be rewriting the plan's content sections, not just appending.

The head prompt, the drive prefix block, and the external-team-lead skill all lack an explicit "do not rewrite plans" directive.

## Metadata

**Complexity:** 4
**Tags:** backend, feature, reliability
**Project:** Browser Switchboard

## User Review Required

No — the changes enforce internal consistency. When the team has no reviewer seat, the lead reports done and stops. The card stays in its coded column until the user advances it — the same board semantics as every other column transition. No role owns the CODE REVIEWED advance when there is no reviewer to dispatch, so no role moves the card.

## Complexity Audit

### Routine
- Modifying the `NEW_CODING_HEAD_PROMPT` constant in `teamWiring.ts` to add the reviewer-seat condition and the plan-immutability directive
- Mirroring the change in `terminals.js` (`NEW_CODING_HEAD_PROMPT_CLIENT` + `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` mirror + standing-orders check update) and `kanban.html` (shipped preset `headPrompt`)
- Adding the plan-immutability rule to the drive prefix block's RULES section in `KanbanProvider.ts`
- Updating `.agents/skills/external-team-lead/SKILL.md` and `.claude/skills/external-team-lead/SKILL.md` Step 4 to make the CODE REVIEWED advance conditional
- Updating `.agents/skills/terminal-coder-dispatch/SKILL.md` and `.claude/skills/terminal-coder-dispatch/SKILL.md` §5.5 to add the plan-immutability rule
- Updating test assertions that pin the head prompt constants

### Complex / Risky
- **Migration for existing installs.** The current `NEW_CODING_HEAD_PROMPT` is already on ~4,000 installs' disks (written by the second migration). Changing it requires a third migration: rename the current `NEW_CODING_HEAD_PROMPT` to a frozen snapshot, create a new `NEW_CODING_HEAD_PROMPT` with the fixes, and add a recogniser that matches the frozen snapshot and replaces it. The standing-orders migration path also needs a new fragment-based recogniser since `{head}` is substituted on disk.

## Edge-Case & Dependency Audit

**Race Conditions:**
- None. The head prompt is text delivered to an agent; the condition is evaluated by the agent at decision time, not by a system component. No concurrent state access.

**Security:**
- No new attack surface. The changes restrict the lead's actions (fewer card moves, no plan edits), not expand them.

**Side Effects:**
- **Reviewer-less teams: features stay in coded columns.** When the team has no reviewer seat, the lead reports completion and stops. The card stays in its coded column until the user advances it — same board semantics as every other column where no role owns the next transition.
- **Plan-file completion reports are unaffected.** The plan-immutability directive prohibits rewriting plan *content*, not appending the completion report. The `CODING_COMPLETION_REPORT_DIRECTIVE` (which says "append a brief summary to the END") is preserved — the lead's coders still write completion reports. The directive targets the *head* rewriting plan sections, not the *coder* appending a report.

**Dependencies & Conflicts:**
- Depends on the existing migration pattern (`isUntouchedCurrentCodingTeam` / `isUntouchedOldCodingTeam`) in `teamWiring.ts` — the new migration follows the same structure.
- The `BUGGY_HEADPROMPT_FRAGMENT` standing-orders recogniser matches `BUGGY_HEADPROMPT_FRAGMENT` ('give that coder the next subtask') — the new head prompt must not contain this fragment (it doesn't in the current text; the new text won't either).
- No conflicts with the "Reviewer Team with Delegation Mode" plan (CODE REVIEWED) — that plan defines *how* the reviewer works once dispatched; this plan gates *whether* the lead dispatches the reviewer at all.

## Dependencies

None — this is a standalone guardrail fix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) The migration must be exact-value matched — if the new `NEW_CODING_HEAD_PROMPT` accidentally contains the old text as a substring, the recogniser could match both. Mitigation: the recogniser uses `===` (exact match), not `indexOf`, for the group `headPrompt` field. (2) The standing-orders migration uses `indexOf` for fragment matching — the new fragment must be unique to the pre-fix text and absent from the new text. Mitigation: the fragment `'then make one call: '` is present in `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` and absent from the new `NEW_CODING_HEAD_PROMPT` (which says `'If your team has a reviewer seat, make one call: '`). The fragment also appears in `CURRENT_BUGGY_CODING_HEAD_PROMPT` — this overlap is harmless (OR condition, same rewrite target). (3) The plan-immutability directive must not conflict with the `CODING_COMPLETION_REPORT_DIRECTIVE` — the directive says "do not rewrite plan content" not "do not write to plan files," and the completion report is an append, not a rewrite. (4) The `terminals.js` standing-orders migration must mirror the new fragment — without it, the webview does not recognize pre-role-boundary installs and the lead receives contradictory text (group `headPrompt` says "check for reviewer" while standing order still says "then make one call"). Mitigation: add `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` to `terminals.js` alongside the existing `OLD_HEADPROMPT_FRAGMENT` and `BUGGY_HEADPROMPT_FRAGMENT` mirrors, and add it to the OR condition in the standing-orders check. (5) The guardrails are prompt-level instructions, not code-level enforcement — an LLM lead can still ignore them. This is an inherent limitation of the system's architecture (all agent behavioral control is prompt-based). A code-level API guard (`POST /kanban/dispatch` rejecting `targetColumn: "CODE REVIEWED"` when no reviewer seat exists) would be actual enforcement but is a different feature with different scope.

## Proposed Changes

### 1. src/services/teamWiring.ts — Rename and replace NEW_CODING_HEAD_PROMPT

**Context:** The current `NEW_CODING_HEAD_PROMPT` (line 382) is the text that the second migration writes to disk. It is now on every install that already migrated. To change the delivered prompt, the current text must become a frozen snapshot (the recogniser for the third migration), and a new `NEW_CODING_HEAD_PROMPT` must carry the corrected text.

**Step 1a: Rename the current `NEW_CODING_HEAD_PROMPT` to `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`.**

Copy the exact current text of `NEW_CODING_HEAD_PROMPT` (line 382-411) to a new constant `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` with a doc comment matching the pattern of `CURRENT_BUGGY_CODING_HEAD_PROMPT`:

```ts
/**
 * The PRE-role-boundary Coding team headPrompt — the text that the second
 * migration (CURRENT_BUGGY_CODING_HEAD_PROMPT → NEW_CODING_HEAD_PROMPT) wrote
 * to disk. This is what is on every install that already migrated to the
 * feature-level prompt. The third migration recogniser matches against this
 * exact value and replaces it with the corrected text (role-boundary guardrails:
 * conditional CODE REVIEWED advance + plan-immutability directive).
 *
 * NEVER edit this constant. It is a frozen snapshot of a string already written
 * to ~4000 installs' disks. New prompt wording goes in NEW_CODING_HEAD_PROMPT
 * only.
 */
export const PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT =
    'You lead this team. Your coders work the subtasks of one feature. Each subtask carries '
    + 'a recommendedRole; dispatch it to a seat of that role on your team. If your team has '
    + 'no such seat, dispatch to a coder and say why in your status report. Your team\'s seats are the '
    + 'ptyListTerminals rows whose parentInstanceId matches your SWITCHBOARD_AGENT_INSTANCE_ID — role alone '
    + 'is not a membership test, and a standalone seat of the same role is not yours to drive. Take the '
    + 'subtask\'s recommendedRole as the routing decision; do not invent complexity tiers. Before sending any '
    + 'seat a revert or stand-down, confirm with git diff that the state you are undoing exists. When a seat fails '
    + 'review on the same subtask twice, do not send that subtask to it a third time — escalate '
    + 'one rung along intern → coder → lead, name the specific defects in the dispatch, and say '
    + 'in your status report which seat you moved it to and why; if the seat that failed twice is '
    + 'a lead, or your team has no seat above it, stop and report to the human instead of '
    + 'dispatching again (or unattended: record the blocked card to .switchboard/orchestrator/reports/ '
    + 'and proceed to the next queue item). When a coder reports a subtask finished, note it and '
    + 'dispatch the next subtask to an idle seat that has not already worked on it — do not stack '
    + 'subtasks on the same coder, or it will hit its context limit mid-task. One subtask per '
    + 'cleared seat before rotation. Do not send anything to the reviewer, and do not write review '
    + 'instructions — that is not your job. When every subtask of the feature is finished, read the '
    + 'port from .switchboard/api-server-port.txt, confirm no subtask is still outstanding via GET '
    + '/kanban/plans?featureId=<the FEATURE planId>&workspaceRoot=<your current working directory — run '
    + 'pwd> (that read returns one record per subtask, each with its kanbanColumn), then make one call: '
    + 'POST /kanban/dispatch with '
    + '{"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED","from":"{head}","workspaceRoot":'
    + '"<your current working directory — run pwd>"} — that one call moves the card and dispatches '
    + 'the reviewer with the reviewer\'s own prompt. Do NOT use /kanban/move: it moves the card and '
    + 'dispatches nobody. Only advance the feature your team worked; leave other cards alone. Do '
    + 'not wait to be asked. When the reviewer reports the feature passed, POST /kanban/queue/next with '
    + '{"from":"{head}"} against the port in .switchboard/api-server-port.txt; if it returns '
    + 'a dispatched card, work it; if it returns dispatched: null, report that the queue is '
    + 'empty and stop.';
```

**Step 1b: Write the new `NEW_CODING_HEAD_PROMPT` with both guardrails.**

Replace the current `NEW_CODING_HEAD_PROMPT` with the corrected text. Two changes from the previous text:

1. **Plan-immutability directive** — added after the opening sentence about leading the team.
2. **Conditional CODE REVIEWED advance** — the unconditional "make one call: POST /kanban/dispatch with targetColumn CODE REVIEWED" becomes conditional on the team having a reviewer seat.

```ts
export const NEW_CODING_HEAD_PROMPT =
    'You lead this team. Your coders work the subtasks of one feature. '
    + 'PLAN FILES ARE THE SOURCE OF TRUTH. Do not rewrite, edit, restructure, or replace plan content. '
    + 'Read the plan, dispatch based on it, review against it — never modify its content. '
    + 'Each subtask carries '
    + 'a recommendedRole; dispatch it to a seat of that role on your team. If your team has '
    + 'no such seat, dispatch to a coder and say why in your status report. Your team\'s seats are the '
    + 'ptyListTerminals rows whose parentInstanceId matches your SWITCHBOARD_AGENT_INSTANCE_ID — role alone '
    + 'is not a membership test, and a standalone seat of the same role is not yours to drive. Take the '
    + 'subtask\'s recommendedRole as the routing decision; do not invent complexity tiers. Before sending any '
    + 'seat a revert or stand-down, confirm with git diff that the state you are undoing exists. When a seat fails '
    + 'review on the same subtask twice, do not send that subtask to it a third time — escalate '
    + 'one rung along intern → coder → lead, name the specific defects in the dispatch, and say '
    + 'in your status report which seat you moved it to and why; if the seat that failed twice is '
    + 'a lead, or your team has no seat above it, stop and report to the human instead of '
    + 'dispatching again (or unattended: record the blocked card to .switchboard/orchestrator/reports/ '
    + 'and proceed to the next queue item). When a coder reports a subtask finished, note it and '
    + 'dispatch the next subtask to an idle seat that has not already worked on it — do not stack '
    + 'subtasks on the same coder, or it will hit its context limit mid-task. One subtask per '
    + 'cleared seat before rotation. Do not send anything to the reviewer, and do not write review '
    + 'instructions — that is not your job. When every subtask of the feature is finished, read the '
    + 'port from .switchboard/api-server-port.txt, confirm no subtask is still outstanding via GET '
    + '/kanban/plans?featureId=<the FEATURE planId>&workspaceRoot=<your current working directory — run '
    + 'pwd> (that read returns one record per subtask, each with its kanbanColumn). '
    + 'Check your team roster (the YOUR TEAM block in your prompt or ptyListTerminals) for a seat '
    + 'with role "reviewer". If your team has a reviewer seat, make one call: '
    + 'POST /kanban/dispatch with '
    + '{"plan":"<the FEATURE planId>","targetColumn":"CODE REVIEWED","from":"{head}","workspaceRoot":'
    + '"<your current working directory — run pwd>"} — that one call moves the card and dispatches '
    + 'the reviewer with the reviewer\'s own prompt. Do NOT use /kanban/move: it moves the card and '
    + 'dispatches nobody. Only advance the feature your team worked; leave other cards alone. Do '
    + 'not wait to be asked. When the reviewer reports the feature passed, POST /kanban/queue/next with '
    + '{"from":"{head}"} against the port in .switchboard/api-server-port.txt; if it returns '
    + 'a dispatched card, work it; if it returns dispatched: null, report that the queue is '
    + 'empty and stop. '
    + 'If your team has NO reviewer seat, do NOT move the card to CODE REVIEWED — that is not your role. '
    + 'Post a finished report to .switchboard/orchestrator/reports/ naming the feature and its planId, '
    + 'and stop. The card stays where it is.';
```

**Step 1c: Add a new migration recogniser and step.**

Add a recogniser function following the `isUntouchedCurrentCodingTeam` pattern:

```ts
/**
 * Recognise an install that already migrated to the feature-level
 * NEW_CODING_HEAD_PROMPT (the text before the role-boundary guardrails).
 *
 * Exact-value match on `headPrompt === PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`.
 * An operator who edited the prompt does not match and is left alone.
 *
 * NEVER edit PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT. It is a frozen snapshot.
 * New prompt wording goes in NEW_CODING_HEAD_PROMPT only.
 */
function isUntouchedPreRoleBoundaryCodingTeam(group: any): boolean {
    if (!group || group.headRole !== 'lead') { return false; }
    return typeof group.headPrompt === 'string'
        && group.headPrompt === PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT;
}
```

Add a new migration step (Step 1d) in `migrateAgentGroups`, after the existing Step 1c:

```ts
// Step 1d: convert an install that already migrated to the feature-level
// headPrompt but before the role-boundary guardrails (conditional CODE REVIEWED
// advance + plan-immutability directive). Exact-value match on
// PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT; an operator-edited group does not match
// and is left alone.
if (isUntouchedPreRoleBoundaryCodingTeam(g)) {
    g = {
        ...g,
        headPrompt: NEW_CODING_HEAD_PROMPT,
    };
    changed = true;
    console.log(
        `[teamWiring] Migration: converted pre-role-boundary Coding team `
        + `'${g.id || g.name}' — headPrompt → role-boundary guardrails.`
    );
}
```

**Step 1d: Add a standing-orders fragment recogniser.**

The standing-orders migration uses `indexOf` for fragment matching (since `{head}` is substituted on disk). Add a new fragment from the pre-role-boundary text that the new text removes or rephrases. The fragment `'then make one call: '` (from the unconditional dispatch instruction) is present in `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` and absent from the new `NEW_CODING_HEAD_PROMPT` (which says `'If your team has a reviewer seat, make one call: '` instead).

```ts
export const PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT = 'then make one call: ';
```

Add it to the standing-orders migration's fragment check alongside `OLD_HEADPROMPT_FRAGMENT` and `BUGGY_HEADPROMPT_FRAGMENT`:

```ts
if (o.instruction.indexOf(OLD_HEADPROMPT_FRAGMENT) !== -1
    || o.instruction.indexOf(BUGGY_HEADPROMPT_FRAGMENT) !== -1
    || o.instruction.indexOf(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT) !== -1) {
    const newInstruction = NEW_CODING_HEAD_PROMPT
        .replace(/\{head\}/g, o.parent || '');
    rewritten.push({ ...o, instruction: newInstruction });
    drop.add(o.id);
    touched = true;
    continue;
}
```

**Important:** The fragment `'then make one call: '` must NOT appear in the new `NEW_CODING_HEAD_PROMPT`. Verify: the new text says `'If your team has a reviewer seat, make one call: '` — the word "then" is removed. The fragment is safe.

### 2. src/webview/terminals.js — Mirror the new NEW_CODING_HEAD_PROMPT_CLIENT and the new fragment

**Step 2a: Update `NEW_CODING_HEAD_PROMPT_CLIENT` (line 9221)** to be byte-identical to the new `NEW_CODING_HEAD_PROMPT` in `teamWiring.ts`. The test in `stage-marker-commit-contract.test.js` (line 356-359) asserts byte-identity between the two.

**Step 2b: Add `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` mirror (after line 9363).**

`terminals.js` carries its own standing-orders migration (lines 9386-9399) with its own copies of `OLD_HEADPROMPT_FRAGMENT` (line 9356) and `BUGGY_HEADPROMPT_FRAGMENT` (line 9363). The existing test `BUGGY_HEADPROMPT_FRAGMENT exists in exactly two files and is byte-identical` (stage-marker-commit-contract.test.js line 570) enforces this two-copy rule. The new fragment must follow the same pattern — without the `terminals.js` mirror, the webview's standing-orders migration does not recognize pre-role-boundary installs, and the host migration fixes the group's `headPrompt` while the standing order still carries the old unconditional dispatch text. The lead would then receive contradictory instructions.

```js
// Mirror of PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT in teamWiring.ts. Recognises
// the feature-level headPrompt before the role-boundary guardrails (conditional
// CODE REVIEWED advance + plan-immutability directive). {head} is substituted
// on disk, so match by indexOf — same as OLD_HEADPROMPT_FRAGMENT and
// BUGGY_HEADPROMPT_FRAGMENT.
var PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT = 'then make one call: ';
```

**Step 2c: Add the fragment to the standing-orders check (line 9387-9388).**

```js
if (o.instruction.indexOf(OLD_HEADPROMPT_FRAGMENT) !== -1
    || o.instruction.indexOf(BUGGY_HEADPROMPT_FRAGMENT) !== -1
    || o.instruction.indexOf(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT) !== -1) {
    var newInstruction = NEW_CODING_HEAD_PROMPT_CLIENT
        .replace(/\{head\}/g, o.parent || '');
```

**Important:** The fragment `'then make one call: '` also appears in `CURRENT_BUGGY_CODING_HEAD_PROMPT` (teamWiring.ts line 444 — the text `via GET /kanban/feature, then make one call: POST /kanban/dispatch`). This overlap is harmless: installs still at the buggy stage already contain `BUGGY_HEADPROMPT_FRAGMENT` (`'give that coder the next subtask'`) and are caught by the existing check. The OR condition means both fragments match the same buggy installs, and they all rewrite to the same `NEW_CODING_HEAD_PROMPT` text. The overlap does not cause double-rewrites or incorrect behavior — it just means the new fragment is not unique to the pre-role-boundary generation. A more unique fragment (e.g. `'each with its kanbanColumn), then make one call: '`) would be cleaner but is not necessary for correctness.

### 3. src/webview/kanban.html — Mirror the new headPrompt in the shipped Coding team preset

Update the `headPrompt` field of the Coding team preset (line 4724) to be byte-identical to the new `NEW_CODING_HEAD_PROMPT`. The test in `stage-marker-commit-contract.test.js` (line 363-376) asserts byte-identity between the shipped `headPrompt` and `NEW_CODING_HEAD_PROMPT`.

### 4. src/services/KanbanProvider.ts — Add plan-immutability rule to drive prefix block

In `_buildDrivePrefix` (line 5449), add a plan-immutability rule to the RULES section (after line 5471):

```ts
'- Do NOT rewrite or edit plan files. The plan is the source of truth — read it, dispatch based on it, review against it, never modify its content.',
```

Also update the FEATURE WATCH line (line 5465) to note the conditional review trigger — or leave it as-is since the watch's `stopColumns: CODE REVIEWED` is about the nudge sweep, not the lead's dispatch. The watch is still correct: it nudges the lead when subtasks are un-accepted, regardless of whether the team has a reviewer. No change needed to the FEATURE WATCH line.

### 5. .agents/skills/external-team-lead/SKILL.md and .claude/skills/external-team-lead/SKILL.md — Conditional CODE REVIEWED advance + plan-immutability

**Step 4 (line 94-124):** Replace the unconditional "Hand whole feature to review" instruction with a conditional one. The current text:

```markdown
- **Hand whole feature to review when all subtasks pass:**
  curl -X POST "$BASE/kanban/dispatch" \
    -H "Content-Type: application/json" \
    -d '{
      "plan": "<featurePlanId>",
      "targetColumn": "CODE REVIEWED",
      "from": "<your-agent-name>"
    }'
```

Becomes:

```markdown
- **Hand whole feature to review when all subtasks pass — ONLY if your team has a reviewer seat:**
  Check your team roster (from `head-prompt.md` or `ptyListTerminals`) for a seat with role "reviewer".
  If your team has a reviewer:
  curl -X POST "$BASE/kanban/dispatch" \
    -H "Content-Type: application/json" \
    -d '{
      "plan": "<featurePlanId>",
      "targetColumn": "CODE REVIEWED",
      "from": "<your-agent-name>"
    }'
  If your team has NO reviewer seat, do NOT move the card. Write a finished report to
  `.switchboard/orchestrator/reports/` naming the feature and its planId, and stop. The card
  stays where it is.
```

Also add a plan-immutability note to the Core Operating Concept section (after line 14):

```markdown
- **Plan files are the source of truth.** You read them, dispatch based on them, and review
  against them. You never rewrite, edit, or restructure plan content. Your only write to a
  plan file is the completion-report append (if you are also coding), never a rewrite of the
  plan's content sections.
```

Apply the same changes to `.claude/skills/external-team-lead/SKILL.md` (the mirror).

### 6. .agents/skills/terminal-coder-dispatch/SKILL.md and .claude/skills/terminal-coder-dispatch/SKILL.md — Plan-immutability rule in §5.5

In §5.5 "The head drives, it does not design" (line 370), add a fourth mandatory rule after rule 3:

```markdown
4. **Plan files are immutable to the head.** The plan is the source of truth. The head reads
   it, dispatches based on it, and reviews against it. The head never rewrites, edits, or
   restructures plan content. The only write to a plan file is the completion-report append by
   a dispatched coder — never a rewrite of the plan's content sections by the head.
```

Apply the same change to `.claude/skills/terminal-coder-dispatch/SKILL.md` (the mirror).

### 7. Tests — Update pinning assertions

**src/test/standing-orders-marker-contract.test.js:**

- The test at line 431-434 reads `NEW_CODING_HEAD_PROMPT` from `teamWiring.ts` source as a quoted chain. The new text will be read the same way — no structural change needed, but the assertions at lines 449 and 471 that check for specific literals (`POST /kanban/queue/next` and the unattended escalation clause) must still pass. Verify the new text preserves these literals.
- Add a new constant check: `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` must differ from `NEW_CODING_HEAD_PROMPT` (same pattern as line 499).
- Add a new constant check: `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` must be a frozen snapshot (same pattern as line 493-494).
- Add assertions that the new `NEW_CODING_HEAD_PROMPT` contains the plan-immutability directive and the conditional reviewer-seat check.

**src/test/stage-marker-commit-contract.test.js:**

- Import `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` alongside the existing imports (line 47-49).
- The byte-identity test between `terminals.js`'s `NEW_CODING_HEAD_PROMPT_CLIENT` and `NEW_CODING_HEAD_PROMPT` (line 356-359) will automatically validate the mirror once `terminals.js` is updated.
- The byte-identity test between `kanban.html`'s shipped `headPrompt` and `NEW_CODING_HEAD_PROMPT` (line 363-376) will automatically validate the mirror once `kanban.html` is updated.
- The load-bearing literal test (line 387-393) must still pass — verify the new text preserves every load-bearing literal. Add new literals to check: `'PLAN FILES ARE THE SOURCE OF TRUTH'` and `'If your team has NO reviewer seat'`.
- The migration test that checks `CURRENT_BUGGY_CODING_HEAD_PROMPT` → `NEW_CODING_HEAD_PROMPT` (line 592-598) is unchanged — it tests the second migration. Add a new test for the third migration: `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` → `NEW_CODING_HEAD_PROMPT`.
- Add a new test `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT exists in exactly two files and is byte-identical` following the pattern of the `BUGGY_HEADPROMPT_FRAGMENT` test (line 570-583). This test must assert: (a) the fragment exists in `teamWiring.ts` and `terminals.js`, (b) the two copies are byte-identical, (c) the fragment appears in `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` (the frozen snapshot it recognises), (d) the fragment does NOT appear in the new `NEW_CODING_HEAD_PROMPT` (or a rewritten row re-matches forever). Note: the fragment also appears in `CURRENT_BUGGY_CODING_HEAD_PROMPT` — this is expected and harmless (see the note in Proposed Changes §2c).

## Verification Plan

1. **Head prompt contains both guardrails.** Assert `NEW_CODING_HEAD_PROMPT` includes `'PLAN FILES ARE THE SOURCE OF TRUTH'` and `'If your team has NO reviewer seat'` and `'do NOT move the card to CODE REVIEWED'`.

2. **Byte-identity across all three copies.** Assert `NEW_CODING_HEAD_PROMPT` (teamWiring.ts) === `NEW_CODING_HEAD_PROMPT_CLIENT` (terminals.js) === shipped `headPrompt` (kanban.html).

3. **Frozen snapshot differs from new prompt.** Assert `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT !== NEW_CODING_HEAD_PROMPT`.

4. **Fragment recogniser is safe.** Assert `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` is present in `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` and absent from `NEW_CODING_HEAD_PROMPT`.

5. **Migration: pre-role-boundary → new.** A group with `headPrompt: PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` is migrated to `NEW_CODING_HEAD_PROMPT` by `migrateAgentGroups`.

6. **Migration: operator-edited group is left alone.** A group with `headPrompt: PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT + ' extra'` is NOT migrated.

7. **Standing-orders migration: fragment match.** A standing order containing `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` is rewritten to the new `NEW_CODING_HEAD_PROMPT` text.

8. **Load-bearing literals preserved.** The new `NEW_CODING_HEAD_PROMPT` still contains: `POST /kanban/queue/next`, the unattended escalation clause, `POST /kanban/dispatch`, `CODE REVIEWED`, `ptyListTerminals`, `parentInstanceId`, `SWITCHBOARD_AGENT_INSTANCE_ID`, `recommendedRole`, the escalation ladder `intern → coder → lead`.

9. **Skill files updated.** Assert `.agents/skills/external-team-lead/SKILL.md` and `.claude/skills/external-team-lead/SKILL.md` both contain `'ONLY if your team has a reviewer seat'` and `'Plan files are the source of truth'`. Assert `.agents/skills/terminal-coder-dispatch/SKILL.md` and `.claude/skills/terminal-coder-dispatch/SKILL.md` both contain `'Plan files are immutable to the head'`.

10. **Drive prefix block includes plan-immutability rule.** Assert the `_buildDrivePrefix` output (or source) contains `'Do NOT rewrite or edit plan files'`.

11. **Fragment mirrored in terminals.js.** Assert `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` exists in both `teamWiring.ts` and `terminals.js` and the two copies are byte-identical. Assert the `terminals.js` standing-orders check (line 9387) includes the new fragment in its OR condition.

12. **Standing-orders migration: fragment match in terminals.js.** A standing order containing `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT` is rewritten to the new `NEW_CODING_HEAD_PROMPT_CLIENT` text by the `terminals.js` migration (not just the `teamWiring.ts` migration).

## Completion Report

Implemented two behavioral guardrails on the Coding team lead: conditional card advancement to CODE REVIEWED (only when a reviewer seat exists on the team) and plan immutability (prohibiting plan content rewrites). Updated prompt constants across `src/services/teamWiring.ts`, `src/webview/terminals.js`, and `src/webview/kanban.html`, created the third migration snapshot `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT` with recognisers in group and standing-orders migration paths, updated `KanbanProvider.ts` drive prefix rules, and updated skill docs in `.agents/skills` and `.claude/skills`. Contract test assertions in `standing-orders-marker-contract.test.js` and `stage-marker-commit-contract.test.js` were updated to verify prompt byte-identity, load-bearing literals, and migration recogniser behavior. No issues were encountered during implementation.

## Review Findings

**Reviewer pass: clean.** All plan requirements verified against code: prompt constants carry both guardrails (plan-immutability + conditional reviewer-seat dispatch), byte-identity holds across teamWiring.ts / terminals.js / kanban.html, migration recognisers (group + standing-orders) fire correctly with idempotent rewrites, and all four skill files carry the updated directives. Contract tests pass: standing-orders-marker 55/55, stage-marker-commit 49/49. Both gates are CI-wired. No CRITICAL or MAJOR findings; three pre-existing NITs (mirror drift, TS7006 in LocalApiServer) are unrelated to this plan. No code fixes applied — no fixes needed.
