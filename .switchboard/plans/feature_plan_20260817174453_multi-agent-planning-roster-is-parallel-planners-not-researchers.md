# The Multi-Agent Planning Team's Roster Is Parallel Planner Seats, Not Two Researchers

## Goal

Change the shipped `Multi-agent planning` team from `planner` head + 2 researchers + 1 analyst to a `planner` head + 3 **planner** seats, and migrate adopted copies. The value of a multi-agent planning team is *several planners planning the same problem in parallel and one head reconciling their drafts* — not one planner with a research pool, which is what the team is today and which is a strictly larger version of a team that already ships.

### Problem analysis and root cause

**The two shipped planner teams are the same team at two sizes.** `SHIPPED_TEAM_TYPES` (`src/webview/kanban.html:4643-4711`) declares:

| Team | Head | Members |
| :--- | :--- | :--- |
| `Batch planners` (`:4644-4659`) | `planner` | 1 × `researcher` (shared, `relationship: 'researcher'`) |
| `Multi-agent planning` (`:4694-4710`) | `planner` | 2 × `researcher` (per-team, `relationship: 'researcher'`) + 1 × `analyst` |

`Multi-agent planning` is `Batch planners` with one more researcher and an analyst. Both are "a planner that can ask other agents for information". Nothing about the second roster makes the *planning* multi-agent; the planning is still done by exactly one agent.

**The roster also makes it overlap an ordinary planner terminal, mechanically.** A team is auto-started by creating an unparented terminal of its head role (`TaskViewerProvider.ts:2867-2884`: `findTeamForHeadRoleInRoots(roots, …, role)` → `payload.delegates = match.team.members`). Both planner teams claim `headRole: 'planner'`, and `migrateAgentGroups` step 3 (`teamWiring.ts:412-424`) awards the role to the first by stored order and marks the other `unassigned`. So once either is adopted, *opening a planner terminal opens that team*. If the team is only "a planner plus researchers", the operator has lost the plain planner and gained nothing they could not have got from a link-up.

**The `researcher` relationship is the wrong shape for parallel planning anyway.** `relationship: 'researcher'` is a `head-receives` preset (`src/services/linkPresets.ts:56-65`); it installs on the head an instruction that is conditional and explicitly non-blocking — *"When you hit a question that needs external sources, documentation or API details you do not already have … Do not block on it."* That is the right contract for a research sidecar and the wrong one for a peer who is supposed to produce a draft plan you must wait for and reconcile against.

**Root cause:** the team was authored by picking a *bigger roster* rather than a *different topology*. `researcher` was reused because it was the nearest existing preset, and the roster grew instead of changing shape.

### The intended shape

Three `planner` seats, `scope: 'per-team'`, `relationship: 'reports-to-head'`. Each seat plans the same problem from its own angle and reports its draft; the head reconciles the drafts into one plan. That is a topology no other shipped team has, and it is the only one where the head's output is a *reconciliation* rather than a *synthesis of inputs it asked for*.

**A planner member does not recursively spawn a planner team.** The auto-start recursion guard is `!payload.parentInstanceId && !payload._isTeamMember` (`TaskViewerProvider.ts:2867`); per-team members are parented by construction and shared members carry `_isTeamMember: true` (`ptyFleetService.ts:485-497`, `:526-536`). A `planner` seat inside a `planner`-headed team joins the team that spawned it and starts nothing of its own. This is stated explicitly in the guard's own comment and is what makes a same-role roster safe.

**Known limitation, stated up front.** A member seat runs the *role's* configured startup command unless its definition carries its own — `injectStartupCommand` (`ptyFleetService.ts:360-370`) falls back to `GlobalIntegrationConfigService.getAgentStartupCommands()[role]`. `DelegateDefinition.startupCommand` exists on the stored member shape (`src/services/agentConfig.ts:3-12`) and is honoured end to end (`spawnDelegates` → `create(…, d.startupCommand, …)`), but the TEAMS-tab member editor does not expose it (`kanban.html:5189-5192` says so explicitly). So after this change the three seats run whatever CLI the `planner` role is configured with. That is a real constraint on cost and it is out of scope here: this plan changes the shipped topology, not the seat-configuration surface.

## Metadata

**Complexity:** 4
**Tags:** feature, ux, frontend, backend
**Project:** Browser Switchboard

## Complexity Audit

### Routine

- Replacing the `members`, `purpose` and `prompt` fields of one object literal in `SHIPPED_TEAM_TYPES`.
- Rendering: the flow diagram derives nodes from `headRole` + `members[]` with no per-role special-casing (`teamsTabRenderFlow`, `kanban.html:4912-5061`), and `teamsTabPortraitId` (`:4735-4742`) already maps `planner` to `#portrait-planner`. Three planner nodes draw with no change.

### Complex / Risky

- **Adopted forks on disk are released state and must be migrated.** `teamsTabAdoptAndStart` (`:5070-5091`) persists a fork into `terminals.agentGroups` at USE time; editing the gallery constant does nothing to it. The migration must follow the existing exact-value recogniser discipline (`isUntouchedOldSeed` / `isUntouchedOldCodingTeam`, `teamWiring.ts:337-379`): replace an *untouched* fork's roster, leave an operator-edited one strictly alone. This is the same shape as step 1, which neutralised the old three-coder seed by rewriting its `members`.
- **A roster replacement is more destructive than a field addition.** Step 1's precedent is the guide: match on exact equality of every field the shipped type set (`name`, `headRole`, `members`, `purpose`, `prompt`), and if any one differs, do nothing. An operator who changed a count, a scope, a relationship or the prompt keeps their team unchanged.
- **Head-role collision is unchanged and must stay unchanged.** Both planner teams still claim `planner`; step 3 still resolves it. Do not "fix" the collision here by changing either team's head role — an operator who wants the plain planner back deletes or re-heads a team, and that is already how the flag works (`teamWiring.ts:412-424`: unassigned means "not the auto-start default", not "broken").
- **Do not invent a new agent role.** `planner` already exists in every role array, has a prompt (`agentPromptBuilder.ts`), a kanban column order, a visibility toggle and a startup-command slot. A new role type would need touching each of those and would buy nothing this roster does not already get.
- **Stale standing orders from a running team.** A team started with the old roster has pair rows keyed `(head, "<head>-researcher-1")`. After the roster change and a restart those child terminals no longer exist, and `selectOrders`'s pair rule (`standingOrders.ts:132-134`) drops any row whose `child` is not live. The rows stay on disk and render for nobody — inert, not wrong. No order migration is needed; do not write one.
- **`MAX_DELEGATES_PER_PARENT` is 8**, so a count of 3 is well inside the per-head cap and inside `instantiateAgentGroupCore`'s pre-flight (`agentGroupInstantiation.ts:78-94`). No cap work.
- **No confirm gate anywhere in this change.**

## Edge-Case & Dependency Audit

**Layout.** `layoutForTeamSize` (`teamWiring.ts:110-115`) picks the smallest rung with `slots >= members.length`. Head + 3 members = 4 names → `2x2`, the same rung the old roster (head + 3 members) produced. No layout change for anyone.

**Member naming.** `spawnDelegates` names per-team members `` `${parent.friendlyName}-${d.label || d.role}${suffix}` `` (`ptyFleetService.ts:518-526`), and with `count > 1` the suffix is `-1..-3`. So seats are `<head>-planner-1`, `-2`, `-3`. Distinct, deterministic, and prefixed by the head name — which is what any head-side member discovery depends on.

**`plannerTerminalCount` is unrelated.** `agents.plannerTerminalCount` (`terminals.js:6891`, `:6907-6913`) controls how many plain planner terminals `OPEN AGENT TERMINALS` creates. It is not read by the team path and is not changed. An operator who opens the grid still gets their configured plain planners; those are unparented creates, so each one triggers the team auto-start exactly as it does today — unchanged behaviour, and the reason the head-role collision note above matters.

**Already-adopted-and-renamed teams.** Skipped by the recogniser, left alone, keep working.

**A team adopted but never started.** The migration runs on the group read path (`_loadAgentGroups` persists the converted array), so the roster is corrected before the first start.

**Shipped-state rule.** `terminals.agentGroups` ships in released versions, so this is a migration, not a clean break. It is idempotent: after the rewrite the fork no longer matches the old-value recogniser.

**Flow-diagram edges.** Edges are typed by `relationship` (`teamsTabRenderFlow`). Dropping the two `researcher` members removes their distinct-labelled edges; three `reports-to-head` seats draw three member→head edges. Confirm the edge renderer handles three identical edges without overlapping labels — the same case the `Coding` team's 3 × coder already exercises, so this is a visual check, not new code.

**Security.** No wire-surface change. The shipped types are static webview constants; the fork is persisted through the existing `saveAgentGroup` message.

## Proposed Changes

### `src/webview/kanban.html` — the shipped type

Replace the `Multi-agent planning` entry (`:4694-4710`):

```js
            {
                name: 'Multi-agent planning',
                headRole: 'planner',
                // Peer planners, not a research pool. Three planner seats draft the
                // SAME problem independently; the head reconciles the drafts. A
                // planner member cannot recursively spawn a planner team — the
                // auto-start guard is `!parentInstanceId && !_isTeamMember`
                // (TaskViewerProvider.ts:2867) and members are parented by
                // construction.
                members: [
                    { role: 'planner', count: 3, scope: 'per-team', relationship: 'reports-to-head' }
                ],
                purpose: 'Three planners draft the same problem independently; the head reconciles the drafts into one plan.',
                prompt: '{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
                    + '{"name":"{child}","data":"<your report>","clearBeforePrompt":false} against the port in '
                    + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.\n'
                    + 'You are one of several planners working the same problem from different angles. Draft your own '
                    + 'plan for the angle you were given — read the code, trace the dependencies, name the root cause '
                    + 'and the risks — and report it to {child}, which reconciles every draft into one plan. Do not '
                    + 'coordinate with the other planners and do not write the final plan yourself.\n'
                    + 'Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout `<path>` / git restore, '
                    + 'git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — '
                    + 'commit first, then correct forward.'
            }
```

### `src/services/teamWiring.ts` — migrate untouched adopted forks

Store the pre-change shipped definition verbatim, beside `OLD_SEEDED_AGENT_GROUP` (`:240-245`):

```ts
/**
 * The PRE-change `Multi-agent planning` fork, preserved verbatim for the
 * migration comparison. Every install that adopted the team before this change
 * has this exact roster/purpose/prompt persisted in `terminals.agentGroups`.
 * Stored, never reconstructed by string-building at match time.
 */
const OLD_MULTI_AGENT_PLANNING: { members: any[]; purpose: string; prompt: string } = {
    members: [
        { role: 'researcher', count: 2, scope: 'per-team', relationship: 'researcher' },
        { role: 'analyst', count: 1, scope: 'per-team', relationship: 'reports-to-head' },
    ],
    purpose: 'Fan-in investigation: multiple agents research from different angles, then synthesize.',
    prompt: /* the shipped pre-change member prompt, verbatim */,
};

/** The post-change roster/purpose/prompt — byte-identical to the kanban.html entry. */
export const MULTI_AGENT_PLANNING_MEMBERS: ReadonlyArray<any> = [
    { role: 'planner', count: 3, scope: 'per-team', relationship: 'reports-to-head' },
];
export const MULTI_AGENT_PLANNING_PURPOSE = 'Three planners draft the same problem independently; the head reconciles the drafts into one plan.';
export const MULTI_AGENT_PLANNING_PROMPT = /* byte-identical to the kanban.html entry */;
```

> The stored `analyst` member carries `relationship: 'reports-to-head'` even though the shipped literal omitted it — `migrateAgentGroups` step 2 (`:390-403`) stamps that default on every member on first read, so what is actually on disk has it. Matching the literal without it would never fire.

Add a step 1c to `migrateAgentGroups`, after the Coding-team step (`:379`):

```ts
        // Step 1c: retopologise an untouched adopted `Multi-agent planning`
        // fork — a planner with a research pool becomes three peer planner
        // seats. Exact-value match on name + headRole + roster + purpose +
        // prompt; any operator edit fails the match and the team is left
        // exactly as authored. Same discipline as step 1's seed neutralisation.
        if (isUntouchedMultiAgentPlanningTeam(g)) {
            g = {
                ...g,
                members: MULTI_AGENT_PLANNING_MEMBERS.map(m => ({ ...m })),
                purpose: MULTI_AGENT_PLANNING_PURPOSE,
                prompt: MULTI_AGENT_PLANNING_PROMPT,
            };
            changed = true;
            console.log(
                `[teamWiring] Migration: retopologised untouched Multi-agent planning team `
                + `'${g.id || g.name}' — 2× researcher + analyst → 3× planner.`
            );
        }
```

with the recogniser beside `isUntouchedOldCodingTeam` (`:581-595`):

```ts
/**
 * Recognise an adopted `Multi-agent planning` fork the operator has not
 * touched. Every field the shipped type set must match exactly — a changed
 * count, scope, relationship, purpose or prompt means the operator owns this
 * team and it is left alone. Deep-compares members by JSON so a re-ordered or
 * extended member object fails the match rather than being silently replaced.
 */
function isUntouchedMultiAgentPlanningTeam(g: any): boolean {
    if (!g || typeof g !== 'object') { return false; }
    if (g.name !== 'Multi-agent planning' || g.headRole !== 'planner') { return false; }
    if (g.purpose !== OLD_MULTI_AGENT_PLANNING.purpose) { return false; }
    if (g.prompt !== OLD_MULTI_AGENT_PLANNING.prompt) { return false; }
    return JSON.stringify(g.members) === JSON.stringify(OLD_MULTI_AGENT_PLANNING.members);
}
```

### `src/test/team-autostart-workspace-scope.test.js` — migration coverage

Add to the `migrateAgentGroups` block:

- an untouched `Multi-agent planning` fork is retopologised to `[{ role: 'planner', count: 3, scope: 'per-team', relationship: 'reports-to-head' }]` and keeps its `id`, `startOnLoad` and any unknown keys;
- the same fork with `count: 3` on the researchers, or a changed `prompt`, or a changed `name`, is returned **byte-identical**;
- running the converter twice is a no-op on the second pass (idempotency).

### `src/test/standing-orders-marker-contract.test.js` — pin the shipped/host pair

Assert `MULTI_AGENT_PLANNING_PROMPT` and `MULTI_AGENT_PLANNING_PURPOSE` in `teamWiring.ts` are byte-identical to the `prompt` and `purpose` of the `Multi-agent planning` entry in `kanban.html`'s `SHIPPED_TEAM_TYPES`, and that its `members` array deep-equals `MULTI_AGENT_PLANNING_MEMBERS`. Without this, the gallery and the migration drift and the recogniser stops firing with no symptom.

## Verification Plan

**Automated**

1. `node src/test/team-autostart-workspace-scope.test.js` — the three new migration cases pass; every existing case (seed neutralisation, Coding step 1b, member-shape defaults, head-role collisions) still passes.
2. `node src/test/standing-orders-marker-contract.test.js` — the shipped/host equality assertions pass.
3. `npx tsc --noEmit -p tsconfig.json` — clean.

**Manual (installed VSIX)**

4. **Fresh install / never adopted.** Board → TEAMS. The `Multi-agent planning` card's roster strip reads `PLANNER · 3 PLANNER`. Click it: the flow diagram draws one head planner and three member planners with three member→head edges, no researcher or analyst node.
5. **Adopt and start.** `USE` the card, then start the team from the terminals panel. Four terminals: `Multi-agent planning`, `Multi-agent planning-planner-1`, `-2`, `-3`. Grid is `2x2`.
6. **No recursion.** Confirm exactly four terminals exist — no member spawned a team of its own. Check the extension log for the team auto-start lines: exactly one team resolution, for the head.
7. **Member prompt lands.** Send a prompt to `-planner-1` from the panel. Its `=== STANDING ORDERS ===` block carries the peer-planner text ("You are one of several planners working the same problem …"), not the researcher preset.
8. **Existing install migrates.** On a build with the old roster, adopt the team so an untouched fork is on disk. Upgrade, reload, open the TEAMS tab. The adopted card's roster strip now reads `PLANNER · 3 PLANNER`; its `id` and any `START ON LOAD` setting are preserved.
9. **Operator edit is respected.** On the old build, adopt the team and change the researcher count to 3. Upgrade and reload: the team must still read `PLANNER · 3 RESEARCHER · 1 ANALYST`, untouched.
10. **Stale orders go inert.** After step 8, restart the migrated team and call `GET /terminals/standing-orders`. The old `(head, "<head>-researcher-1")` pair rows may still be listed on disk, but a prompt delivered to the head must not render them (their child is not live). Confirm by sending the head a prompt and reading the block.
