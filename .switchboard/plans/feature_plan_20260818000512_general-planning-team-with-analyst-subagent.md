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

## Complexity Audit

**Routine:**
- Adding a `SHIPPED_TEAM_TYPES` entry is a static data addition — no new logic, no new endpoints.
- The `analyst` role is already a first-class built-in role with a startup command, a sidebar portrait mapping (`portrait-agent`), and a grid slot.
- The team prompt follows the same template as the other three shipped teams (callback + git safety + role-specific instruction).

**Low risk:**
- The gallery renderer (`teamsTabRenderGallery`) already iterates `SHIPPED_TEAM_TYPES` and renders cards for each. A new entry is picked up automatically.
- `wireSpawnedTeam` handles `scope: 'per-team'` members with `relationship: 'reports-to-head'` — the analyst reports to the head, carried by the team-scoped standing order. No pair-scoped order is generated.

## Edge-Case & Dependency Audit

1. **Analyst role visibility.** The `analyst` role must be visible in the agent grid for the team to spawn correctly. It is listed in `GRID_BUILTIN_ROLES` (`terminals.js:6867`), so it is spawned by `resolveGridAgents`. If the operator has hidden the analyst role via the AGENTS tab, the team member spawn will produce a plain shell — the same behaviour as any hidden-role member in any shipped team.
2. **Head prompt.** Unlike the Coding team, this planning team does not need a `headPrompt` — the planner head's standing order is the team prompt (callback + git safety + the dispatch-to-analyst instruction). The planner does not advance kanban cards, so no dispatch instructions are needed.
3. **Gallery card rendering.** `teamsTabPortraitId` maps `analyst` to `portrait-agent` (the generic portrait). The planner maps to `portrait-planner`. The card will render correctly.
4. **Auto-start.** The team's `headRole` is `planner`. If the operator already has a `planner`-headed team adopted (Batch planners or Multi-agent planning), the auto-start collision resolver (`migrateAgentGroups` step 3 in `teamWiring.ts`) marks subsequent teams with the same head role as `unassigned`. This is correct — the operator picks which planner team to start explicitly.
5. **Member count.** One analyst member (`count: 1, scope: 'per-team'`). The layout ladder resolves to `2h` (2 slots for head + 1 member).

## Proposed Changes

### `src/webview/kanban.html` — `SHIPPED_TEAM_TYPES` (after the Multi-agent planning entry, ~line 4716)

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

### `src/test/standing-orders-marker-contract.test.js` — update shipped-team count assertion

The marker contract test asserts the number of shipped teams and the prompt count. Adding a fourth team type with one `prompt` field increases both counts by one. Update the assertions:

```javascript
// The test at the top of the SHIPPED_TEAM_TYPES block asserts the number of
// teams and the number of prompt: fields. Both increase by 1 (one new team,
// one new prompt). Update the expected counts accordingly.
```

The exact assertion lines to update depend on the test's current expected values — read the test and bump the team count and prompt count by 1.

## Verification Plan

1. **Gallery renders the new card.** Open the TEAMS tab. Confirm a "Planning with analyst" card appears in the gallery with the correct purpose text and portrait icons (planner head + analyst member).
2. **USE & START.** Click USE & START on the "Planning with analyst" card. Confirm two terminals spawn: `planner-1` (head) and `analyst-1` (member), seated in a 2h layout.
3. **Standing orders installed.** After spawn, check that the analyst's terminal receives the team-scoped standing order (callback + git safety + analyst instruction) and the planner's terminal receives no team-head order (no `headPrompt` on this team). Verify via the standing-orders editor in the sidebar.
4. **Analyst callback works.** Send a code-search task to the analyst. Confirm it reports back to the planner via `ptySendPrompt` when done.
5. **Auto-start collision.** If Batch planners is already adopted, confirm the new team is marked `unassigned` and does not auto-start when a planner terminal is opened. It can still be started explicitly from the gallery.
6. **Run tests.** `npx jest src/test/standing-orders-marker-contract.test.js` — confirm the updated team/prompt count assertions pass.
