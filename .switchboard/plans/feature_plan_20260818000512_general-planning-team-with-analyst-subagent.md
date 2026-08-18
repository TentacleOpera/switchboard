# General planning team with analyst subagent to save lead tokens

## Goal

Add a new shipped team type — a general-purpose planning team where the planner head delegates code search, dependency tracing, and other investigative work to an analyst member, saving the lead's context window and token budget for synthesis and plan authoring.

### Problem Analysis & Root Cause

The existing planning teams are either too narrow or too heavy:
- **Batch planners** (planner + 1 researcher): the researcher investigates and reports back, but the head still does all code search itself when the researcher's findings need follow-up lookups.
- **Multi-agent planning** (planner + 2 researchers + analyst): a fan-in investigation team designed for divergent research angles, not for a lead that wants a single general-purpose subagent to offload routine code search and context-gathering onto.

What is missing is a **general planning team**: a planner head with one analyst member that acts as a general-purpose subagent. The lead dispatches code-search and context-gathering tasks to the analyst; the analyst does the reading and reports concise findings back; the lead synthesizes without spending its own tokens on the search itself. This is the "save the lead's code search and other use tokens" the user described.

The team is a new entry in `SHIPPED_TEAM_TYPES` in `kanban.html`. No backend changes are needed — `wireSpawnedTeam` already handles arbitrary member roles and the `analyst` role is already a known role in `GRID_BUILTIN_ROLES` (`terminals.js:6867`) and in `KNOWN_ROLE_WORDS` (`teamWiring.ts:1380`).

## Metadata

**Complexity:** 3
**Tags:** frontend, feature, ui
**Project:** Browser Switchboard

## User Review Required

Not required — the plan is a static data addition with no design decisions. Proceed with implementation.

## Complexity Audit

### Routine
- Adding a `SHIPPED_TEAM_TYPES` entry is a static data addition — no new logic, no new endpoints.
- The `analyst` role is already a first-class built-in role with a startup command, a sidebar portrait mapping (`portrait-agent`), and a grid slot.
- The team prompt follows the same template as the other three shipped teams (callback + git safety + role-specific instruction).

### Complex / Risky
- The gallery renderer (`teamsTabRenderGallery`) already iterates `SHIPPED_TEAM_TYPES` and renders cards for each. A new entry is picked up automatically.
- `wireSpawnedTeam` handles `scope: 'per-team'` members with `relationship: 'reports-to-head'` — the analyst reports to the head, carried by the team-scoped standing order. No pair-scoped order is generated.

## Edge-Case & Dependency Audit

1. **Analyst role visibility.** The `analyst` role must be visible in the agent grid for the team to spawn correctly. It is listed in `GRID_BUILTIN_ROLES` (`terminals.js:6867`), so it is spawned by `resolveGridAgents`. If the operator has hidden the analyst role via the AGENTS tab, the team member spawn will produce a plain shell — the same behaviour as any hidden-role member in any shipped team.
2. **Head prompt.** Unlike the Coding team, this planning team does not need a `headPrompt` — the planner head's standing order is the team prompt (callback + git safety + the dispatch-to-analyst instruction). The planner does not advance kanban cards, so no dispatch instructions are needed.
3. **Gallery card rendering.** `teamsTabPortraitId` maps `analyst` to `portrait-agent` (the generic portrait). The planner maps to `portrait-planner`. The card will render correctly.
4. **Auto-start.** The team's `headRole` is `planner`. If the operator already has a `planner`-headed team adopted (Batch planners or Multi-agent planning), the auto-start collision resolver (`migrateAgentGroups` step 3 in `teamWiring.ts`) marks subsequent teams with the same head role as `unassigned`. This is correct — the operator picks which planner team to start explicitly.
5. **Member count.** One analyst member (`count: 1, scope: 'per-team'`). The layout ladder resolves to `2h` (2 slots for head + 1 member).

## Dependencies

None — this plan is independent. It adds a new static team type entry; no other subtask in this feature touches `SHIPPED_TEAM_TYPES` or the shipped-team count assertion.

## Adversarial Synthesis

Key risks: (1) the contract test at `standing-orders-marker-contract.test.js:329` asserts `prompts.length === 3` — adding a fourth team with a `prompt` field bumps this to 4 and the assertion must be updated in the same change. (2) The `headPrompt` count assertion (line 362) asserts exactly 1 — the new team has no `headPrompt`, so this is unaffected. Mitigations: update the prompt-count assertion from 3 to 4; verify the headPrompt-count assertion still passes unchanged.

## Proposed Changes

### `src/webview/kanban.html` — `SHIPPED_TEAM_TYPES` (after the Multi-agent planning entry, ~line 4722)

Add a new team type:

```javascript
{
    name: 'Planning with analyst',
    headRole: 'planner',
    members: [
        { role: 'analyst', count: 1, scope: 'per-team', relationship: 'reports-to-head' }
    ],
    purpose: 'A planner with a general-purpose analyst that handles code search and context-gathering, saving the lead\'s tokens for synthesis.',
    prompt: '{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
        + '{"name":"{child}","data":"<your report>","clearBeforePrompt":false} against the port in '
        + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.\n'
        + 'You are a general-purpose analyst for the planning lead. Your job is code search, dependency tracing, '
        + 'and context-gathering: read the codebase, trace imports and call sites, identify root causes, and report '
        + 'concise findings to {child}. Do not write plans yourself — your reports are input the lead synthesizes into '
        + 'the plan. When the lead dispatches a search or investigation task, do it thoroughly and report only what is '
        + 'relevant to the task.\n'
        + 'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, '
        + 'git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — '
        + 'commit first, then correct forward. '
        + 'Stage by explicit path only the files belonging to the work you are committing — never `git add -A` or `git add .` — '
        + 'other agents may be working the same tree.'
}
```

### `src/webview/kanban.html` — `teamsTabPortraitId` (no change needed)

The `analyst` role already resolves to `portrait-agent` via the fallback in `teamsTabPortraitId` (line 4747). The planner head resolves to `portrait-planner`. No change required.

### `src/test/standing-orders-marker-contract.test.js` — update shipped-team prompt count assertion (line 329)

The marker contract test asserts `prompts.length === 3` (line 329) — the number of shipped team `prompt` fields. Adding a fourth team type with one `prompt` field increases this to 4. Update the assertion:

```javascript
// Line 329: change from 3 to 4
assert.strictEqual(
    prompts.length, 4,
    `Expected 4 shipped team prompts, found ${prompts.length}. The gallery ships exactly ` +
    'four team types (Batch planners, Coding, Multi-agent planning, Planning with analyst) and each must carry a prompt.'
);
```

The `headPromptMatches.length` assertion (line 362) asserts exactly 1 — the new team has no `headPrompt`, so this is unaffected. The byte-identity assertion between `kanban.html` and `teamWiring.ts` (line 408) applies only to the Coding team's `headPrompt` — also unaffected.

## Verification Plan

1. **Gallery renders the new card.** Open the TEAMS tab. Confirm a "Planning with analyst" card appears in the gallery with the correct purpose text and portrait icons (planner head + analyst member).
2. **USE & START.** Click USE & START on the "Planning with analyst" card. Confirm two terminals spawn: `planner-1` (head) and `analyst-1` (member), seated in a 2h layout.
3. **Standing orders installed.** After spawn, check that the analyst's terminal receives the team-scoped standing order (callback + git safety + analyst instruction) and the planner's terminal receives no team-head order (no `headPrompt` on this team). Verify via the standing-orders editor in the sidebar.
4. **Analyst callback works.** Send a code-search task to the analyst. Confirm it reports back to the planner via `ptySendPrompt` when done.
5. **Auto-start collision.** If Batch planners is already adopted, confirm the new team is marked `unassigned` and does not auto-start when a planner terminal is opened. It can still be started explicitly from the gallery.
6. **Run tests.** `npx jest src/test/standing-orders-marker-contract.test.js` — confirm the updated team/prompt count assertions pass.

## Completion Report

Implemented the "Planning with analyst" team type in `SHIPPED_TEAM_TYPES` in `src/webview/kanban.html`. The team consists of a `planner` head and one `analyst` member with `relationship: 'reports-to-head'` and purpose-built instructions for code search and context gathering. Updated the test assertion in `src/test/standing-orders-marker-contract.test.js` to expect 4 shipped team prompts. No issues encountered.

## Review Findings

Reviewed in place; no CRITICAL or MAJOR findings against this subtask. Verified the `Planning with analyst` entry in `src/webview/kanban.html` (4 shipped types parse, `analyst` resolves to `portrait-agent` via the `teamsTabPortraitId` fallback at `kanban.html:4774`, `reports-to-head` is `member-receives` in `linkPresets.ts:107` so no pair-scoped order is minted, and `analyst` is in `GRID_BUILTIN_ROLES` at `terminals.js:7007`), plus the prompt-count bump to 4 in `src/test/standing-orders-marker-contract.test.js:329`. Validation: `standing-orders-marker-contract` 55/55, `stage-marker-commit-contract` 47/47, `tsc -p tsconfig.test.json` clean, `mirror:check` green. Files changed by this subtask: `src/webview/kanban.html`, `src/test/standing-orders-marker-contract.test.js`. Remaining risk: none specific to this entry — the head-role collision with the two other planner-headed teams is handled by `migrateAgentGroups` step 3 and is the intended behaviour.
